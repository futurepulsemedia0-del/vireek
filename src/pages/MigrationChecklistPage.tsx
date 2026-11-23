import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowRightLeft, CheckCircle2, Circle, Download, ExternalLink, Lock, RefreshCw } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { SkeletonCard } from '@/components/Skeleton';
import { useMigrationT } from '@/i18n/migrationNamespace';
import { listImportJobs, downloadTextFile, type ImportJobRecord } from '@/lib/importWizard';
import {
  buildValidationReport, formatCents, MIGRATION_ENTITIES, MIGRATION_SOURCES, parseCountInput, parseMoneyToCents, reportToCsv,
  type Check, type ControlTotals, type MigrationEntity, type MigrationSnapshot, type MigrationSource,
} from '@/lib/migrationValidation';
import { CHECKLIST_PHASES, evaluateChecklist, type StepStatus } from '@/lib/migrationChecklist';
import { fetchControlTotals, fetchManualProgress, fetchValidationSnapshot, saveControlTotals, setManualStep } from '@/lib/migrationApi';

const MONEY_FIELDS = ['jobRevenueCents', 'invoiceTotalCents', 'paymentsTotalCents', 'openBalanceCents'] as const;
type FormState = Record<string, string>;

const STATUS_STYLE: Record<StepStatus, string> = {
  done: 'bg-success/10 text-success',
  todo: 'bg-bg-tertiary text-text-secondary',
  attention: 'bg-warning-subtle text-warning',
  blocked: 'bg-danger/10 text-danger',
};
const CHECK_STYLE: Record<Check['status'], string> = {
  pass: 'bg-success/10 text-success',
  warn: 'bg-warning-subtle text-warning',
  fail: 'bg-danger/10 text-danger',
  info: 'bg-bg-tertiary text-text-secondary',
  na: 'bg-bg-tertiary text-text-secondary',
};
const ENTITY_CHECKS = new Set(['rows_accounted', 'matches_source', 'row_errors', 'present_in_account']);

const toForm = (c: ControlTotals): FormState => {
  const f: FormState = {};
  for (const e of MIGRATION_ENTITIES) if (c.rows?.[e] !== undefined) f[`rows_${e}`] = String(c.rows[e]);
  for (const k of MONEY_FIELDS) if (c[k] !== undefined) f[k] = (c[k]! / 100).toFixed(2);
  return f;
};

/** Returns the parsed totals and the keys that failed to parse (empty string = skipped, not invalid). */
function parseForm(f: FormState): { totals: ControlTotals; invalid: string[] } {
  const invalid: string[] = [];
  const rows: Partial<Record<MigrationEntity, number>> = {};
  const totals: ControlTotals = {};
  for (const e of MIGRATION_ENTITIES) {
    const raw = (f[`rows_${e}`] ?? '').trim();
    if (!raw) continue;
    const n = parseCountInput(raw);
    if (n === null) invalid.push(`rows_${e}`); else rows[e] = n;
  }
  if (Object.keys(rows).length) totals.rows = rows;
  for (const k of MONEY_FIELDS) {
    const raw = (f[k] ?? '').trim();
    if (!raw) continue;
    const c = parseMoneyToCents(raw);
    if (c === null) invalid.push(k); else totals[k] = c;
  }
  return { totals, invalid };
}

export function MigrationChecklistPage() {
  const { isOwner, permissions, profile, teamMember, loading, profileLoading } = useAuth();
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canAccess = isOwner || permissions.can_edit_business_profile;
  const { t } = useMigrationT();
  const { toast } = useToast();

  const [source, setSource] = useState<MigrationSource>('jobber');
  const [sourceTouched, setSourceTouched] = useState(false);
  const [jobs, setJobs] = useState<ImportJobRecord[]>([]);
  const [snapshot, setSnapshot] = useState<MigrationSnapshot | null>(null);
  const [control, setControl] = useState<ControlTotals>({});
  const [form, setForm] = useState<FormState>({});
  const [invalid, setInvalid] = useState<string[]>([]);
  const [manualDone, setManualDone] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingStep, setPendingStep] = useState<string | null>(null);
  const [savingTotals, setSavingTotals] = useState(false);

  // Default the selector to the source of the most recent import, once, unless the person already chose.
  useEffect(() => {
    if (sourceTouched || !jobs.length) return;
    const s = jobs[0].source;
    if ((MIGRATION_SOURCES as readonly string[]).includes(s) && s !== source) setSource(s as MigrationSource);
  }, [jobs, sourceTouched, source]);

  const load = useCallback(async () => {
    if (!accountOwnerId || !canAccess) return;
    setBusy(true);
    setError(null);
    try {
      const [j, snap, ctl, manual] = await Promise.all([
        listImportJobs(accountOwnerId),
        fetchValidationSnapshot(source),
        fetchControlTotals(accountOwnerId, source),
        fetchManualProgress(accountOwnerId, source),
      ]);
      setJobs(j); setSnapshot(snap); setControl(ctl); setForm(toForm(ctl)); setManualDone(manual); setInvalid([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('page.loadError'));
    } finally {
      setBusy(false);
    }
  }, [accountOwnerId, canAccess, source, t]);

  useEffect(() => { void load(); }, [load]);

  const report = useMemo(() => (snapshot ? buildValidationReport(snapshot, jobs, control) : null), [snapshot, jobs, control]);
  const state = useMemo(() => evaluateChecklist(manualDone, report, jobs, source), [manualDone, report, jobs, source]);

  const toggleStep = async (id: string, done: boolean) => {
    if (!accountOwnerId || pendingStep) return;
    setPendingStep(id);
    try {
      await setManualStep(accountOwnerId, source, id, done);
      setManualDone((prev) => { const n = new Set(prev); if (done) n.add(id); else n.delete(id); return n; });
    } catch {
      toast(t('page.saveFailed'), 'error');
    } finally {
      setPendingStep(null);
    }
  };

  const submitTotals = async () => {
    if (!accountOwnerId) return;
    const { totals, invalid: bad } = parseForm(form);
    setInvalid(bad);
    if (bad.length) { toast(t('control.invalid'), 'error'); return; }
    setSavingTotals(true);
    try {
      await saveControlTotals(accountOwnerId, source, totals);
      setControl(totals);
      toast(t('control.saved'), 'success');
    } catch {
      toast(t('page.saveFailed'), 'error');
    } finally {
      setSavingTotals(false);
    }
  };

  const fmt = (c: Check, n: number | undefined) => (n === undefined ? '—' : c.isMoney ? formatCents(n) : n.toLocaleString());
  const checkLabel = (c: Check) => {
    const [prefix] = c.id.split('.');
    if (c.entity && ENTITY_CHECKS.has(prefix)) return t(`report.checks.${prefix}`, { entity: t(`report.entities.${c.entity}`) });
    return t(`report.checks.${c.id.replace('.', '_')}`);
  };

  if (loading || profileLoading) {
    return <DashboardLayout activeLabel="Switching to Vireek"><SkeletonCard rows={4} /></DashboardLayout>;
  }

  if (!canAccess || !accountOwnerId) {
    return (
      <DashboardLayout activeLabel="Switching to Vireek">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} aria-hidden /></span>
          <h1 className="mt-4 text-lg font-semibold text-text-primary">{t('page.noAccessTitle')}</h1>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">{t('page.noAccessBody')}</p>
        </div>
      </DashboardLayout>
    );
  }

  const groups: Check['group'][] = ['counts', 'unmatched', 'duplicates', 'money'];

  return (
    <DashboardLayout activeLabel="Switching to Vireek">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><ArrowRightLeft size={24} aria-hidden /></span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">{t('page.title')}</h1>
          <p className="text-sm text-text-secondary">{t('page.subtitle')}</p>
        </div>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <label htmlFor="migration-source" className="text-sm font-medium text-text-primary">{t('page.sourceLabel')}</label>
        <select
          id="migration-source"
          value={source}
          onChange={(e) => { setSourceTouched(true); setSource(e.target.value as MigrationSource); }}
          className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
        >
          {MIGRATION_SOURCES.map((s) => <option key={s} value={s}>{t(`sources.${s}`)}</option>)}
        </select>
        <Link to="/dashboard/imports" className="focus-ring ms-auto inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm text-accent hover:underline">
          {t('page.openImports')} <ExternalLink size={14} aria-hidden />
        </Link>
      </div>

      {busy && !snapshot ? <SkeletonCard rows={6} /> : error ? (
        <div role="alert" className="flex flex-col items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger">
          <span className="flex items-center gap-2"><AlertCircle size={16} aria-hidden />{error}</span>
          <button type="button" onClick={() => void load()} className="focus-ring inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium underline">
            <RefreshCw size={12} aria-hidden />{t('page.retry')}
          </button>
        </div>
      ) : (
        <div className="space-y-8">
          {/* Progress */}
          <section aria-labelledby="mig-progress">
            <div className="flex items-center justify-between text-sm">
              <h2 id="mig-progress" className="font-semibold text-text-primary">{t('page.progress', { done: state.requiredDone, total: state.requiredTotal })}</h2>
              <span className="tabular-nums text-text-secondary">{state.percent}%</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-bg-tertiary" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={state.percent}>
              <div className="h-full rounded-full bg-accent transition-[width] motion-reduce:transition-none" style={{ width: `${state.percent}%` }} />
            </div>
          </section>

          {/* Checklist */}
          {CHECKLIST_PHASES.map((phase) => (
            <section key={phase} aria-labelledby={`mig-${phase}`}>
              <h2 id={`mig-${phase}`} className="mb-3 text-lg font-semibold text-text-primary">{t(`phases.${phase}`)}</h2>
              <ul className="space-y-2">
                {state.steps.filter((s) => s.phase === phase).map((s) => (
                  <li key={s.id} className="flex items-start gap-3 rounded-xl border border-border bg-bg-secondary p-4">
                    {s.kind === 'manual' ? (
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={s.status === 'done'}
                        aria-label={s.status === 'done' ? t('markUndone') : t('markDone')}
                        disabled={pendingStep !== null}
                        onClick={() => void toggleStep(s.id, s.status !== 'done')}
                        className="focus-ring mt-0.5 rounded-full text-text-secondary disabled:opacity-50"
                      >
                        {s.status === 'done' ? <CheckCircle2 size={20} className="text-success" aria-hidden /> : <Circle size={20} aria-hidden />}
                      </button>
                    ) : (
                      <span className="mt-0.5" aria-hidden>{s.status === 'done' ? <CheckCircle2 size={20} className="text-success" /> : <Circle size={20} className="text-text-secondary" />}</span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold text-text-primary">{t(`steps.${s.id}.title`)}</h3>
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[s.status]}`}>{t(`status.${s.status}`)}</span>
                      </div>
                      <p className="mt-1 text-sm leading-relaxed text-text-secondary">{t(`steps.${s.id}.body`)}</p>
                    </div>
                    {s.href && (
                      <Link to={s.href} className="focus-ring shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-accent hover:underline">{t('page.openScreen')}</Link>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {/* Control totals */}
          <section aria-labelledby="mig-control" className="rounded-2xl border border-border bg-bg-secondary p-5">
            <h2 id="mig-control" className="text-lg font-semibold text-text-primary">{t('control.title')}</h2>
            <p className="mt-1 text-sm text-text-secondary">{t('control.body')}</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {[...MIGRATION_ENTITIES.map((e) => `rows_${e}`), ...MONEY_FIELDS].map((k) => (
                <div key={k}>
                  <label htmlFor={`ctl-${k}`} className="mb-1 block text-xs font-medium text-text-secondary">{t(`control.fields.${k}`)}</label>
                  <input
                    id={`ctl-${k}`}
                    inputMode={k.startsWith('rows_') ? 'numeric' : 'decimal'}
                    value={form[k] ?? ''}
                    onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
                    aria-invalid={invalid.includes(k)}
                    dir="ltr"
                    className={`focus-ring w-full rounded-xl border bg-bg-primary px-3 py-2 text-sm text-text-primary ${invalid.includes(k) ? 'border-danger' : 'border-border'}`}
                  />
                </div>
              ))}
            </div>
            <button type="button" onClick={() => void submitTotals()} disabled={savingTotals}
              className="focus-ring mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:brightness-110 disabled:opacity-50">
              {savingTotals ? t('page.saving') : t('control.save')}
            </button>
          </section>

          {/* Validation report */}
          <section aria-labelledby="mig-report">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <div>
                <h2 id="mig-report" className="text-lg font-semibold text-text-primary">{t('report.title')}</h2>
                <p className="text-sm text-text-secondary">{t('report.subtitle')}</p>
              </div>
              <div className="ms-auto flex gap-2">
                <button type="button" onClick={() => void load()} disabled={busy}
                  className="focus-ring inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-text-primary disabled:opacity-50">
                  <RefreshCw size={12} className={busy ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden />{t('report.refresh')}
                </button>
                {report && report.verdict !== 'not_started' && (
                  <button type="button" onClick={() => downloadTextFile(`migration-validation-${source}.csv`, reportToCsv(report), 'text/csv')}
                    className="focus-ring inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-text-primary">
                    <Download size={12} aria-hidden />{t('report.download')}
                  </button>
                )}
              </div>
            </div>

            {!report || report.verdict === 'not_started' ? (
              <div className="rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-12 text-center">
                <h3 className="text-base font-semibold text-text-primary">{t('report.emptyTitle')}</h3>
                <p className="mx-auto mt-1 max-w-md text-sm text-text-secondary">{t('report.emptyBody')}</p>
              </div>
            ) : (
              <>
                <p role="status" className={`mb-4 inline-block rounded-full px-3 py-1 text-sm font-medium ${report.verdict === 'ready' ? CHECK_STYLE.pass : report.verdict === 'review' ? CHECK_STYLE.warn : CHECK_STYLE.fail}`}>
                  {t(`report.verdict.${report.verdict}`)}
                </p>
                {groups.map((g) => {
                  const rows = report.checks.filter((c) => c.group === g && c.status !== 'na');
                  if (!rows.length) return null;
                  return (
                    <div key={g} className="mb-5 overflow-x-auto rounded-xl border border-border">
                      <table className="w-full min-w-[34rem] text-sm">
                        <caption className="bg-bg-secondary px-4 py-2 text-start text-sm font-semibold text-text-primary">{t(`report.groups.${g}`)}</caption>
                        <thead>
                          <tr className="border-t border-border text-xs text-text-secondary">
                            <th scope="col" className="px-4 py-2 text-start font-medium">{t('report.columns.check')}</th>
                            <th scope="col" className="px-3 py-2 text-end font-medium">{t('report.columns.expected')}</th>
                            <th scope="col" className="px-3 py-2 text-end font-medium">{t('report.columns.actual')}</th>
                            <th scope="col" className="px-3 py-2 text-end font-medium">{t('report.columns.difference')}</th>
                            <th scope="col" className="px-4 py-2 text-start font-medium">{t('report.columns.status')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((c) => (
                            <tr key={c.id} className="border-t border-border">
                              <td className="px-4 py-2 text-text-primary">{checkLabel(c)}</td>
                              <td className="px-3 py-2 text-end tabular-nums text-text-secondary" dir="ltr">{fmt(c, c.expected)}</td>
                              <td className="px-3 py-2 text-end tabular-nums text-text-primary" dir="ltr">{fmt(c, c.actual)}</td>
                              <td className="px-3 py-2 text-end tabular-nums text-text-secondary" dir="ltr">{c.diff === undefined ? '—' : (c.diff > 0 ? '+' : '') + fmt(c, c.diff)}</td>
                              <td className="px-4 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${CHECK_STYLE[c.status]}`}>{t(`report.status.${c.status}`)}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                })}

                {report.duplicateGroups.length > 0 && (
                  <div className="rounded-xl border border-border bg-bg-secondary p-4">
                    <div className="mb-2 flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-text-primary">{t('report.duplicatesTitle')}</h3>
                      <Link to="/dashboard/customers" className="focus-ring text-xs font-medium text-accent hover:underline">{t('report.openCustomers')}</Link>
                    </div>
                    <ul className="space-y-2">
                      {report.duplicateGroups.map((g, i) => (
                        <li key={`${g.kind}-${i}`} className="text-sm">
                          <span className="font-medium text-text-primary">{t(`report.duplicatesKind.${g.kind}`)}</span>
                          <span className="text-text-secondary"> · {g.members.map((m) => (m.imported ? `${m.name} (${t('report.importedTag')})` : m.name)).join(', ')}</span>
                        </li>
                      ))}
                    </ul>
                    {report.duplicateGroupsTotal > report.duplicateGroups.length && (
                      <p className="mt-2 text-xs text-text-secondary">{t('report.duplicatesMore', { shown: report.duplicateGroups.length, total: report.duplicateGroupsTotal })}</p>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </DashboardLayout>
  );
}
