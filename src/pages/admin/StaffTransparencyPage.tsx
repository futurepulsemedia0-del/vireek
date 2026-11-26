// /staff/transparency — compile, approve and publish transparency reports; curate the public AI incident log.
// Access is enforced by RLS and SECURITY DEFINER staff checks (see 20290312000000_transparency_report.sql);
// the route sits behind <StaffRoute>. Nothing here is public until a human publishes it.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { Pill, SelectField, formatDateTime, type Tone } from '@/components/vehicles/shared';
import { useToast } from '@/contexts/ToastContext';
import { useTransparencyT } from '@/i18n/transparencyNamespace';
import { AI_INCIDENT_SEVERITIES, AI_INCIDENT_TYPES } from '@/lib/aiIncidents';
import { AUTOMATED_REDACTION_RULES, MANUAL_REDACTION_RULES, findRedactionIssues } from '@/lib/incidentRedaction';
import { useSEO } from '@/lib/seo';
import {
  TransparencyApiError, createEntry, createReport, listEntries, listReports, refreshReport, updateEntry, updateReport,
  type StaffEntry, type TransparencyErrorKind,
} from '@/lib/transparencyApi';
import {
  approvalBlockers, labelFor, lastClosedPeriod, periodBounds, publishBlocker, reportToMarkdown, type StaffReport,
} from '@/lib/transparencyReport';

const STATUS_TONE: Record<string, Tone> = { draft: 'warning', approved: 'info', published: 'success', unpublished: 'neutral' };
const today = () => new Date().toISOString().slice(0, 10);

function SEO() {
  useSEO({ title: 'Transparency — Staff', description: 'Internal: transparency reports and public AI incident log.', canonical: 'https://vireek.com/staff/transparency' });
  return null;
}

type Load<T> = { phase: 'loading' } | { phase: 'error' } | { phase: 'ready'; data: T };

function useErrorText() {
  const { t } = useTransparencyT();
  return (e: unknown): string => {
    const kind: TransparencyErrorKind = e instanceof TransparencyApiError ? e.kind : 'generic';
    return t(`errors.${kind}`, { rule: e instanceof TransparencyApiError && e.rule ? t(`rules.${e.rule}`) : '' });
  };
}

// ---------------------------------------------------------------------------------------------- reports

function ReportCard({ report, onChanged }: { report: StaffReport; onChanged: () => void }) {
  const { t } = useTransparencyT();
  const { toast } = useToast();
  const errText = useErrorText();
  const [intro, setIntro] = useState(report.introText);
  const [rules, setRules] = useState(report.reportingRulesText);
  const [counsel, setCounsel] = useState(report.counselApprovedOn ?? '');
  const [correction, setCorrection] = useState(report.correctionsText);
  const [busy, setBusy] = useState<string | null>(null);
  const frozen = report.status === 'published' || report.status === 'unpublished';

  const run = async (key: string, fn: () => Promise<unknown>, okKey: string) => {
    if (busy) return;
    setBusy(key);
    try { await fn(); toast(t(okKey), 'success'); onChanged(); } catch (e) { toast(errText(e), 'error'); } finally { setBusy(null); }
  };

  const blockers = approvalBlockers({ introText: intro, reportingRulesText: rules, metrics: report.metrics });
  const pubBlock = publishBlocker(report);
  const bounds = periodBounds(report.periodLabel);

  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(reportToMarkdown({ ...report, introText: intro, reportingRulesText: rules }));
      toast(t('toast.copied'), 'success');
    } catch { toast(t('errors.generic'), 'error'); }
  };

  return (
    <Card interactive={false} className="p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold text-text-primary">{report.periodLabel}</h3>
        <Pill tone={STATUS_TONE[report.status] ?? 'neutral'}>{t(`status.${report.status}`)}</Pill>
        {bounds && <span className="text-xs text-text-secondary">{bounds.start} – {bounds.end} (UTC)</span>}
      </div>
      {report.compiledAt && <p className="mt-1 text-xs text-text-secondary">{t('reports.compiledAt', { when: formatDateTime(report.compiledAt) })}</p>}

      <div className="mt-4 space-y-4">
        <Textarea label={t('reports.introLabel')} rows={4} value={intro} maxLength={4000} disabled={frozen} onChange={(e) => setIntro(e.target.value)} />
        <Textarea label={t('reports.rulesLabel')} helperText={t('reports.rulesHelp')} rows={4} value={rules} maxLength={4000} disabled={frozen} onChange={(e) => setRules(e.target.value)} />
        <Input label={t('reports.counselDate')} type="date" max={today()} value={counsel} disabled={frozen} onChange={(e) => setCounsel(e.target.value)} />
      </div>

      {!frozen && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" loading={busy === 'save'} loadingLabel={t('loading')}
            onClick={() => void run('save', () => updateReport(report.id, { introText: intro, reportingRulesText: rules, counselApprovedOn: counsel || null }), 'toast.updated')}>{t('reports.save')}</Button>
          <Button variant="secondary" loading={busy === 'refresh'} loadingLabel={t('loading')}
            onClick={() => void run('refresh', () => refreshReport(report.id), 'toast.recompiled')}>{t('reports.recompile')}</Button>
          {report.status === 'draft' && (
            <Button loading={busy === 'approve'} loadingLabel={t('loading')} disabled={blockers.length > 0 || !counsel}
              onClick={() => void run('approve', () => updateReport(report.id, { introText: intro, reportingRulesText: rules, counselApprovedOn: counsel, status: 'approved' }), 'toast.updated')}>{t('reports.approve')}</Button>
          )}
          {report.status === 'approved' && (
            <Button loading={busy === 'publish'} loadingLabel={t('loading')} disabled={pubBlock !== null}
              onClick={() => { if (window.confirm(t('reports.confirmPublish', { period: report.periodLabel }))) void run('publish', () => updateReport(report.id, { status: 'published' }), 'toast.published'); }}>{t('reports.publish')}</Button>
          )}
          <Button variant="secondary" onClick={() => void copyDraft()}>{t('reports.copyDraft')}</Button>
        </div>
      )}
      {!frozen && report.status === 'draft' && blockers.length > 0 && (
        <ul className="mt-2 list-disc ps-5 text-xs text-text-secondary">{blockers.map((b) => <li key={b}>{t(`reports.blockers.${b}`)}</li>)}</ul>
      )}
      {!frozen && report.status === 'approved' && pubBlock && <p className="mt-2 text-xs text-text-secondary">{t(`reports.publishBlocker.${pubBlock}`)}</p>}
      {!frozen && <p className="mt-2 text-xs text-text-secondary">{t('reports.recompileNote')}</p>}

      {report.status === 'published' && (
        <div className="mt-4 space-y-3">
          <Textarea label={t('reports.correction')} rows={2} value={correction} maxLength={2000} onChange={(e) => setCorrection(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" loading={busy === 'corr'} loadingLabel={t('loading')}
              onClick={() => void run('corr', () => updateReport(report.id, { correctionsText: correction }), 'toast.updated')}>{t('reports.addCorrection')}</Button>
            <Button variant="secondary" loading={busy === 'wd'} loadingLabel={t('loading')}
              onClick={() => { if (window.confirm(t('reports.confirmWithdraw'))) void run('wd', () => updateReport(report.id, { status: 'unpublished' }), 'toast.withdrawn'); }}>{t('reports.withdraw')}</Button>
          </div>
        </div>
      )}

      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-medium text-text-primary">{t('reports.figures')}</summary>
        <div className="mt-2 max-h-80 overflow-auto">
          <table className="w-full text-start text-xs">
            <tbody>
              {report.metrics.map((m) => (
                <tr key={`${m.section}|${m.metric}|${m.dimension}|${m.key}`} className="border-b border-border">
                  <td className="py-1 pe-2 text-text-secondary">{m.section} · {m.metric}{m.dimension ? ` · ${m.dimension}` : ''}</td>
                  <td className="py-1 pe-2 text-text-primary">{m.key ? labelFor(m.key) : ''}</td>
                  <td className="py-1 text-end font-semibold tabular-nums text-text-primary">{m.count ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Card>
  );
}

function ReportsTab() {
  const { t } = useTransparencyT();
  const { toast } = useToast();
  const errText = useErrorText();
  const [state, setState] = useState<Load<StaffReport[]>>({ phase: 'loading' });
  const [period, setPeriod] = useState(lastClosedPeriod());
  const [suppress, setSuppress] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => { listReports().then((data) => setState({ phase: 'ready', data })).catch(() => setState({ phase: 'error' })); }, []);
  useEffect(() => { load(); }, [load]);

  const periods = useMemo(() => {
    const y = new Date().getUTCFullYear();
    return [`${y}-H2`, `${y}-H1`, `${y - 1}-H2`, `${y - 1}-H1`];
  }, []);

  const create = async () => {
    if (creating) return;
    const k = suppress.trim() === '' ? null : Number(suppress);
    if (k !== null && (!Number.isInteger(k) || k < 2 || k > 100)) { toast(t('errors.invalid'), 'error'); return; }
    setCreating(true);
    try { await createReport(period, k); toast(t('toast.created'), 'success'); load(); } catch (e) { toast(errText(e), 'error'); } finally { setCreating(false); }
  };

  return (
    <div className="space-y-4">
      <Card interactive={false} className="p-4 sm:p-5">
        <h2 className="text-lg font-semibold text-text-primary">{t('reports.newHeading')}</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <SelectField label={t('reports.period')} value={period} onChange={(e) => setPeriod(e.target.value)}>
            {periods.map((p) => <option key={p} value={p}>{p}</option>)}
          </SelectField>
          <Input label={t('reports.suppress')} helperText={t('reports.suppressHelp')} inputMode="numeric" value={suppress} onChange={(e) => setSuppress(e.target.value.replace(/[^0-9]/g, ''))} />
        </div>
        <div className="mt-4"><Button loading={creating} loadingLabel={t('reports.creating')} onClick={() => void create()}>{t('reports.create')}</Button></div>
      </Card>
      {state.phase === 'loading' && <p className="text-sm text-text-secondary">{t('loading')}</p>}
      {state.phase === 'error' && <p role="alert" className="text-sm text-danger">{t('errors.load')}</p>}
      {state.phase === 'ready' && state.data.length === 0 && <p className="text-sm text-text-secondary">{t('reports.empty')}</p>}
      {state.phase === 'ready' && state.data.map((r) => <ReportCard key={`${r.id}-${r.status}-${r.compiledAt}`} report={r} onChanged={load} />)}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- public incident log

function EntryCard({ entry, onChanged }: { entry: StaffEntry; onChanged: () => void }) {
  const { t } = useTransparencyT();
  const { toast } = useToast();
  const errText = useErrorText();
  const [checked, setChecked] = useState(entry.redactionCheckedOn !== null);
  const [counsel, setCounsel] = useState(entry.counselApprovedOn ?? '');
  const [correction, setCorrection] = useState(entry.correctionNote);
  const [busy, setBusy] = useState<string | null>(null);
  const frozen = entry.status === 'published' || entry.status === 'unpublished';

  const run = async (key: string, patch: Parameters<typeof updateEntry>[1], okKey: string) => {
    if (busy) return;
    setBusy(key);
    try { await updateEntry(entry.id, patch); toast(t(okKey), 'success'); onChanged(); } catch (e) { toast(errText(e), 'error'); } finally { setBusy(null); }
  };

  return (
    <Card interactive={false} className="p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-text-secondary">{entry.publicRef} · {entry.occurredOn}</span>
        <Pill tone={STATUS_TONE[entry.status] ?? 'neutral'}>{t(`status.${entry.status}`)}</Pill>
      </div>
      <h3 className="mt-1 text-base font-semibold text-text-primary">{entry.title}</h3>
      <p className="mt-2 text-sm text-text-secondary">{entry.whatHappened}</p>
      <p className="mt-1 text-sm text-text-secondary">{entry.impact}</p>
      <p className="mt-1 text-sm text-text-secondary">{entry.whatWeDid}</p>

      {!frozen && (
        <div className="mt-4 space-y-3">
          <label className="flex items-start gap-2 text-sm text-text-primary">
            <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            <span>{t('log.redactionDone')}</span>
          </label>
          <Input label={t('log.counselDate')} type="date" max={today()} value={counsel} onChange={(e) => setCounsel(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" loading={busy === 'checks'} loadingLabel={t('loading')}
              onClick={() => void run('checks', { redactionCheckedOn: checked ? entry.redactionCheckedOn ?? today() : null, counselApprovedOn: counsel || null }, 'toast.updated')}>{t('log.saveChecks')}</Button>
            {entry.status === 'draft' && (
              <Button loading={busy === 'approve'} loadingLabel={t('loading')} disabled={!checked || !counsel}
                onClick={() => void run('approve', { redactionCheckedOn: entry.redactionCheckedOn ?? today(), counselApprovedOn: counsel, status: 'approved' }, 'toast.updated')}>{t('log.approve')}</Button>
            )}
            {entry.status === 'approved' && (
              <Button loading={busy === 'publish'} loadingLabel={t('loading')}
                onClick={() => { if (window.confirm(t('log.confirmPublish'))) void run('publish', { status: 'published' }, 'toast.published'); }}>{t('log.publish')}</Button>
            )}
          </div>
        </div>
      )}
      {entry.status === 'published' && (
        <div className="mt-4 space-y-3">
          <Textarea label={t('log.correction')} rows={2} value={correction} maxLength={1000} onChange={(e) => setCorrection(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" loading={busy === 'corr'} loadingLabel={t('loading')} onClick={() => void run('corr', { correctionNote: correction }, 'toast.updated')}>{t('log.addCorrection')}</Button>
            <Button variant="secondary" loading={busy === 'wd'} loadingLabel={t('loading')}
              onClick={() => { if (window.confirm(t('log.confirmWithdraw'))) void run('wd', { status: 'unpublished' }, 'toast.withdrawn'); }}>{t('log.withdraw')}</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function EntryForm({ onCreated }: { onCreated: () => void }) {
  const { t } = useTransparencyT();
  const { toast } = useToast();
  const errText = useErrorText();
  const [f, setF] = useState({ title: '', incidentType: 'wrong_diagnosis', severity: 'medium', occurredOn: '', whatHappened: '', impact: '', whatWeDid: '' });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));

  const issues = useMemo(() => [f.title, f.whatHappened, f.impact, f.whatWeDid].flatMap((x) => findRedactionIssues(x)), [f]);
  const fieldIssue = (v: string) => { const i = findRedactionIssues(v)[0]; return i ? t('log.found', { rule: t(`rules.${i.rule}`) }) : undefined; };
  const sizeErr = (v: string, min: number) => (v.trim().length > 0 && v.trim().length < min ? t('errors.tooShort') : undefined);
  const invalid = f.title.trim().length < 3 || f.whatHappened.trim().length < 20 || f.impact.trim().length < 10 || f.whatWeDid.trim().length < 10 || !f.occurredOn || f.occurredOn > today() || issues.length > 0;

  const submit = async (e: { preventDefault: () => void }) => {
    e.preventDefault();
    if (saving || invalid) return;
    setSaving(true);
    try {
      await createEntry({ incidentId: null, ...f });
      toast(t('toast.created'), 'success');
      setF({ title: '', incidentType: 'wrong_diagnosis', severity: 'medium', occurredOn: '', whatHappened: '', impact: '', whatWeDid: '' });
      onCreated();
    } catch (err) { toast(errText(err), 'error'); } finally { setSaving(false); }
  };

  return (
    <Card interactive={false} className="p-4 sm:p-5">
      <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4" aria-labelledby="tr-entry-heading">
        <h2 id="tr-entry-heading" className="text-lg font-semibold text-text-primary">{t('log.newHeading')}</h2>
        <p className="text-sm text-text-secondary">{t('log.intro')}</p>
        <Input label={t('log.title')} value={f.title} maxLength={160} required error={fieldIssue(f.title)} onChange={(e) => set('title', e.target.value)} />
        <div className="grid gap-4 sm:grid-cols-3">
          <SelectField label={t('log.type')} value={f.incidentType} onChange={(e) => set('incidentType', e.target.value)}>
            {AI_INCIDENT_TYPES.map((v) => <option key={v} value={v}>{t(`types.${v}`)}</option>)}
          </SelectField>
          <SelectField label={t('log.severity')} value={f.severity} onChange={(e) => set('severity', e.target.value)}>
            {AI_INCIDENT_SEVERITIES.map((v) => <option key={v} value={v}>{t(`severities.${v}`)}</option>)}
          </SelectField>
          <Input label={t('log.occurredOn')} type="date" max={today()} value={f.occurredOn} required onChange={(e) => set('occurredOn', e.target.value)} />
        </div>
        <Textarea label={t('log.whatHappened')} rows={4} value={f.whatHappened} maxLength={2000} required error={fieldIssue(f.whatHappened) ?? sizeErr(f.whatHappened, 20)} onChange={(e) => set('whatHappened', e.target.value)} />
        <Textarea label={t('log.impact')} rows={3} value={f.impact} maxLength={1000} required error={fieldIssue(f.impact) ?? sizeErr(f.impact, 10)} onChange={(e) => set('impact', e.target.value)} />
        <Textarea label={t('log.whatWeDid')} rows={4} value={f.whatWeDid} maxLength={2000} required error={fieldIssue(f.whatWeDid) ?? sizeErr(f.whatWeDid, 10)} onChange={(e) => set('whatWeDid', e.target.value)} />
        <div className="grid gap-4 text-xs text-text-secondary sm:grid-cols-2">
          <div><p className="font-medium text-text-primary">{t('log.automatedRules')}</p><ul className="list-disc ps-5">{AUTOMATED_REDACTION_RULES.map((r) => <li key={r}>{t(`rules.${r}`)}</li>)}</ul></div>
          <div><p className="font-medium text-text-primary">{t('log.manualRules')}</p><ul className="list-disc ps-5">{MANUAL_REDACTION_RULES.map((r) => <li key={r}>{t(`rules.${r}`)}</li>)}</ul></div>
        </div>
        <Button type="submit" loading={saving} loadingLabel={t('log.creating')} disabled={invalid}>{t('log.create')}</Button>
      </form>
    </Card>
  );
}

function LogTab() {
  const { t } = useTransparencyT();
  const [state, setState] = useState<Load<StaffEntry[]>>({ phase: 'loading' });
  const load = useCallback(() => { listEntries().then((data) => setState({ phase: 'ready', data })).catch(() => setState({ phase: 'error' })); }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="space-y-4">
      <EntryForm onCreated={load} />
      {state.phase === 'loading' && <p className="text-sm text-text-secondary">{t('loading')}</p>}
      {state.phase === 'error' && <p role="alert" className="text-sm text-danger">{t('errors.load')}</p>}
      {state.phase === 'ready' && state.data.length === 0 && <p className="text-sm text-text-secondary">{t('log.empty')}</p>}
      {state.phase === 'ready' && state.data.map((e) => <EntryCard key={`${e.id}-${e.status}`} entry={e} onChanged={load} />)}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- page

export function StaffTransparencyPage() {
  const { t } = useTransparencyT();
  const [tab, setTab] = useState<'reports' | 'log'>('reports');
  return (
    <>
      <SEO />
      <Header />
      <main className="mx-auto max-w-4xl space-y-6 px-4 pb-16 pt-24 sm:px-6">
        <header>
          <h1 className="text-2xl font-bold text-text-primary">{t('title')}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t('intro')}</p>
        </header>
        <div role="tablist" aria-label={t('title')} className="flex gap-2">
          {(['reports', 'log'] as const).map((k) => (
            <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)}
              className={`min-h-11 rounded-lg px-4 text-sm font-medium ${tab === k ? 'bg-bg-secondary text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}>{t(`tabs.${k}`)}</button>
          ))}
        </div>
        <div role="tabpanel">{tab === 'reports' ? <ReportsTab /> : <LogTab />}</div>
      </main>
    </>
  );
}
