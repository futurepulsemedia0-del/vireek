import { useMemo, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { useGrowthT } from '@/i18n/growthNamespace';
import {
  createExperiment, fetchExperimentResults, listExperiments, transitionExperiment, type ExperimentSummary,
} from '@/lib/growth/growthApi';
import { analyzeGrowthExperiment, type GrowthAlpha, type GrowthMetric } from '@/lib/growth/growthExperiments';
import { AsyncBoundary, DataTable, Notice, SectionTitle, Td, useAsync, useFormatters } from './growthShared';

const KEY_RE = /^[a-z][a-z0-9_]{1,62}[a-z0-9]$/;
const field = 'focus-ring rounded-lg border border-border bg-bg-secondary px-2 py-1 text-sm text-text-primary';

export function ExperimentsTab() {
  const { t } = useGrowthT();
  const list = useAsync(listExperiments, 'exps');
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-6">
      <Notice>{t('exp.principles')}</Notice>
      <CreateForm onCreated={list.reload} />
      <section aria-labelledby="g-explist" className="space-y-3">
        <SectionTitle id="g-explist">{t('exp.list')}</SectionTitle>
        <AsyncBoundary state={list}>
          {(rows) => rows.length === 0 ? <Notice>{t('exp.empty')}</Notice> : (
            <ul className="space-y-3">
              {rows.map((e) => (
                <li key={e.key} className="space-y-3 rounded-xl border border-border p-4">
                  <ExperimentRow e={e} onChanged={list.reload} onToggle={() => setOpen(open === e.key ? null : e.key)} expanded={open === e.key} />
                  {open === e.key && <Results experimentKey={e.key} />}
                </li>
              ))}
            </ul>
          )}
        </AsyncBoundary>
      </section>
    </div>
  );
}

function CreateForm({ onCreated }: { onCreated: () => void }) {
  const { t } = useGrowthT();
  const [v, setV] = useState({ key: '', name: '', hypothesis: '', surface: 'onboarding' as 'onboarding' | 'trial' | 'pricing', share: '50', metric: 'activated_7d' as GrowthMetric, days: '14', alpha: '0.05' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => setV((p) => ({ ...p, [k]: val }));

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const share = Number(v.share);
    const days = Number(v.days);
    if (!KEY_RE.test(v.key) || v.name.trim().length < 1 || v.hypothesis.trim().length < 10 || !(share >= 5 && share <= 95) || !(days >= 7 && days <= 90)) {
      setErr(t('exp.invalid'));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await createExperiment({ key: v.key, name: v.name.trim(), hypothesis: v.hypothesis.trim(), surface: v.surface, treatmentShare: Math.round(share), primaryMetric: v.metric, minRuntimeDays: Math.round(days), alpha: Number(v.alpha) as GrowthAlpha });
      setV((p) => ({ ...p, key: '', name: '', hypothesis: '' }));
      onCreated();
    } catch {
      setErr(t('exp.createFailed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} noValidate className="grid gap-3 rounded-xl border border-border p-4 sm:grid-cols-3" aria-labelledby="g-expnew">
      <h2 id="g-expnew" className="text-base font-semibold text-text-primary sm:col-span-3">{t('exp.new')}</h2>
      <div className="flex flex-col gap-1"><label htmlFor="ex-key" className="text-xs text-text-secondary">{t('exp.key')}</label><input id="ex-key" className={field} value={v.key} onChange={(e) => set('key', e.target.value)} aria-describedby="ex-key-h" required /><span id="ex-key-h" className="text-[11px] text-text-secondary">{t('exp.keyHint')}</span></div>
      <div className="flex flex-col gap-1"><label htmlFor="ex-name" className="text-xs text-text-secondary">{t('exp.name')}</label><input id="ex-name" className={field} value={v.name} maxLength={120} onChange={(e) => set('name', e.target.value)} required /></div>
      <div className="flex flex-col gap-1"><label htmlFor="ex-surf" className="text-xs text-text-secondary">{t('exp.surface')}</label>
        <select id="ex-surf" className={field} value={v.surface} onChange={(e) => set('surface', e.target.value as typeof v.surface)}>
          <option value="onboarding">{t('exp.surfaces.onboarding')}</option><option value="trial">{t('exp.surfaces.trial')}</option><option value="pricing">{t('exp.surfaces.pricing')}</option>
        </select></div>
      <div className="flex flex-col gap-1 sm:col-span-3"><label htmlFor="ex-hyp" className="text-xs text-text-secondary">{t('exp.hypothesis')}</label><textarea id="ex-hyp" className={field} rows={2} maxLength={1000} value={v.hypothesis} onChange={(e) => set('hypothesis', e.target.value)} required /></div>
      <div className="flex flex-col gap-1"><label htmlFor="ex-metric" className="text-xs text-text-secondary">{t('exp.metric')}</label>
        <select id="ex-metric" className={field} value={v.metric} onChange={(e) => set('metric', e.target.value as GrowthMetric)}>
          <option value="activated_7d">{t('exp.metrics.activated_7d')}</option><option value="trial_to_paid">{t('exp.metrics.trial_to_paid')}</option>
        </select></div>
      <div className="flex flex-col gap-1"><label htmlFor="ex-share" className="text-xs text-text-secondary">{t('exp.share')}</label><input id="ex-share" inputMode="numeric" className={field} value={v.share} onChange={(e) => set('share', e.target.value)} /></div>
      <div className="flex flex-col gap-1"><label htmlFor="ex-days" className="text-xs text-text-secondary">{t('exp.minDays')}</label><input id="ex-days" inputMode="numeric" className={field} value={v.days} onChange={(e) => set('days', e.target.value)} /></div>
      <div className="flex flex-col gap-1"><label htmlFor="ex-alpha" className="text-xs text-text-secondary">{t('exp.alpha')}</label>
        <select id="ex-alpha" className={field} value={v.alpha} onChange={(e) => set('alpha', e.target.value)}><option value="0.1">0.10</option><option value="0.05">0.05</option><option value="0.01">0.01</option></select></div>
      <div className="sm:col-span-3"><Button type="submit" size="sm" loading={busy}>{t('exp.create')}</Button></div>
      {err && <p role="alert" className="text-xs text-danger sm:col-span-3">{err}</p>}
    </form>
  );
}

function ExperimentRow({ e, onChanged, onToggle, expanded }: { e: ExperimentSummary; onChanged: () => void; onToggle: () => void; expanded: boolean }) {
  const { t } = useGrowthT();
  const [priceOk, setPriceOk] = useState(false);
  const [decision, setDecision] = useState<'adopt' | 'iterate' | 'reject' | ''>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const act = async (to: 'running' | 'concluded' | 'archived') => {
    setBusy(true);
    setErr(false);
    try {
      await transitionExperiment(e.key, to, { decision: decision || undefined, priceIntegrity: priceOk });
      onChanged();
    } catch {
      setErr(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-text-primary">{e.name} <code className="text-xs text-text-secondary">{e.key}</code></p>
          <p className="text-xs text-text-secondary">{t(`exp.status.${e.status}`)} · {t(`exp.surfaces.${e.surface}`)} · {t('exp.assignedN', { n: e.assigned })}</p>
        </div>
        <Button size="xs" variant="ghost" onClick={onToggle} aria-expanded={expanded}>{t('exp.results')}</Button>
      </div>
      <p className="text-xs text-text-secondary">{e.hypothesis}</p>
      {e.status === 'draft' && (
        <div className="flex flex-wrap items-center gap-3">
          {e.surface === 'pricing' && (
            <label className="flex items-start gap-2 text-xs text-text-primary">
              <input type="checkbox" checked={priceOk} onChange={(ev) => setPriceOk(ev.target.checked)} className="mt-0.5" />
              <span>{t('exp.priceIntegrity')}</span>
            </label>
          )}
          <Button size="xs" loading={busy} disabled={e.surface === 'pricing' && !priceOk} disabledReason={e.surface === 'pricing' && !priceOk ? t('exp.priceIntegrityNeeded') : undefined} onClick={() => act('running')}>{t('exp.start')}</Button>
          <Button size="xs" variant="ghost" onClick={() => act('archived')}>{t('exp.archive')}</Button>
        </div>
      )}
      {e.status === 'running' && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`dec-${e.key}`} className="text-xs text-text-secondary">{t('exp.decision')}</label>
          <select id={`dec-${e.key}`} className={field} value={decision} onChange={(ev) => setDecision(ev.target.value as typeof decision)}>
            <option value="">—</option><option value="adopt">{t('exp.decisions.adopt')}</option><option value="iterate">{t('exp.decisions.iterate')}</option><option value="reject">{t('exp.decisions.reject')}</option>
          </select>
          <Button size="xs" loading={busy} disabled={decision === ''} onClick={() => act('concluded')}>{t('exp.conclude')}</Button>
        </div>
      )}
      {e.status === 'concluded' && <Button size="xs" variant="ghost" onClick={() => act('archived')}>{t('exp.archive')}</Button>}
      {err && <p role="alert" className="text-xs text-danger">{t('exp.transitionFailed')}</p>}
    </div>
  );
}

function Results({ experimentKey }: { experimentKey: string }) {
  const { t } = useGrowthT();
  const f = useFormatters();
  const res = useAsync(() => fetchExperimentResults(experimentKey), `r-${experimentKey}`);
  const now = useMemo(() => new Date(), []);
  return (
    <AsyncBoundary state={res}>
      {(raw) => {
        const a = analyzeGrowthExperiment(raw, now);
        const c = raw.arms.control;
        const tr = raw.arms.treatment;
        const metricN = (arm: typeof c) => (!arm ? '—' : raw.experiment.primary_metric === 'activated_7d' ? `${arm.activation_k}/${arm.activation_n}` : `${arm.trial_k}/${arm.trial_n}`);
        return (
          <div className="space-y-3" aria-live="polite">
            <p className="text-sm text-text-primary">
              <strong>{t(`exp.verdict.${a.verdict}`)}</strong> — {t(`exp.recommendation.${a.recommendation}`)}
            </p>
            {a.reasons.length > 0 && <ul className="list-disc ps-5 text-xs text-text-secondary">{a.reasons.map((r) => <li key={r}>{t(`exp.reason.${r}`)}</li>)}</ul>}
            <DataTable caption={t('exp.results')} head={[t('exp.arm'), t('exp.assigned'), t('exp.primaryCounts'), t('exp.payingN')]}>
              <tr><Td>{t('exp.control')}</Td><Td>{c?.assigned ?? 0}</Td><Td>{metricN(c)}</Td><Td>{c?.paying_n ?? 0}</Td></tr>
              <tr><Td>{t('exp.treatment')}</Td><Td>{tr?.assigned ?? 0}</Td><Td>{metricN(tr)}</Td><Td>{tr?.paying_n ?? 0}</Td></tr>
            </DataTable>
            {a.primary && (
              <p className="text-sm text-text-primary">
                {t('exp.effect', { effect: `${f.num(a.primary.effect * 100)} pp`, low: f.num(a.primary.ciLow * 100), high: f.num(a.primary.ciHigh * 100), p: f.num(a.primary.p, 3) })}
              </p>
            )}
            <p className="text-xs text-text-secondary">
              {t('exp.runtime', { elapsed: f.num(a.elapsedDays, 0), min: raw.experiment.min_runtime_days })} · {a.srm ? t('exp.srm', { p: f.num(a.srm.p, 4), status: a.srm.failed ? t('exp.srmFail') : t('exp.srmOk') }) : ''}
            </p>
            <p className="text-xs text-text-secondary">{t('exp.guardrail', { name: t('exp.guardrailCancel'), status: t(`exp.guardrailStatus.${a.guardrail.status}`) })}</p>
          </div>
        );
      }}
    </AsyncBoundary>
  );
}
