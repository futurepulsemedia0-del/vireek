/**
 * One acquisition — /dashboard/acquisitions/:id
 * Tabs: 30/60/90 plan · Day one · Data checks · Synergies · Settings.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Building2, Loader2, Lock, Trash2 } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { Field, InlineError, Pill, fieldCls, panelCls, useAcquisitionsScope } from '@/components/acquisitions/acquisitionUi';
import { WorkstreamTracker } from '@/components/acquisitions/WorkstreamTracker';
import { DayOneDashboard } from '@/components/acquisitions/DayOneDashboard';
import { DataChecksPanel } from '@/components/acquisitions/DataChecksPanel';
import { SynergyPanel } from '@/components/acquisitions/SynergyPanel';
import {
  deleteAcquisition, describeAcquisitionError, fetchAcquisition, fetchAcquisitionStatus, fetchKpiReport, fetchLinkOptions, updateAcquisition,
  type AcquisitionBundle, type LinkOptions,
} from '@/lib/acquisitionsApi';
import { listImportJobs, type ImportJobRecord } from '@/lib/importWizard';
import { PHASE_LABELS, SCOPE_LABELS, STATUS_LABELS, currentPhase, dayNumber, formatCents, todayIso, type AcquisitionStatus, type KpiReport } from '@/lib/acquisitions';

type Tab = 'plan' | 'dayone' | 'checks' | 'synergies' | 'settings';
const TABS: { id: Tab; label: string }[] = [
  { id: 'plan', label: '30/60/90 plan' }, { id: 'dayone', label: 'Day one' }, { id: 'checks', label: 'Data checks' }, { id: 'synergies', label: 'Synergies' }, { id: 'settings', label: 'Settings' },
];
const EDITABLE_STATUS: AcquisitionStatus[] = ['planned', 'integrating', 'on_hold', 'completed'];

export function AcquisitionDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { loading: authLoading, profileLoading } = useAuth();
  const { accountOwnerId, canManage } = useAcquisitionsScope();
  const today = useMemo(() => todayIso(), []);
  const tab: Tab = TABS.some((t) => t.id === search.get('tab')) ? (search.get('tab') as Tab) : 'plan';

  const [bundle, setBundle] = useState<AcquisitionBundle | null>(null);
  const [options, setOptions] = useState<LinkOptions | null>(null);
  const [report, setReport] = useState<KpiReport | null>(null);
  const [reportState, setReportState] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });
  const [importJobs, setImportJobs] = useState<ImportJobRecord[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const loadReport = useCallback(async () => {
    setReportState({ loading: true, error: null });
    try { const r = await fetchKpiReport(id); if (alive.current) { setReport(r); setReportState({ loading: false, error: null }); } }
    catch (e) { if (alive.current) setReportState({ loading: false, error: describeAcquisitionError(e) }); }
  }, [id]);

  const load = useCallback(async () => {
    if (!accountOwnerId || !canManage || !id) return;
    setState('loading'); setError(null);
    try {
      const b = await fetchAcquisition(id, accountOwnerId);
      if (!alive.current) return;
      if (!b) { setState('missing'); return; }
      setBundle(b); setState('ready');
      void loadReport();
      fetchLinkOptions(accountOwnerId).then((o) => { if (alive.current) setOptions(o); }).catch(() => undefined);
      listImportJobs(accountOwnerId).then((j) => { if (alive.current) { setImportJobs(j); setImportError(null); } }).catch((e: unknown) => { if (alive.current) setImportError(e instanceof Error ? e.message : 'Could not load import runs.'); });
    } catch (e) { if (alive.current) { setError(describeAcquisitionError(e)); setState('error'); } }
  }, [accountOwnerId, canManage, id, loadReport]);

  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [load]);

  const patch = useCallback((fn: (b: AcquisitionBundle) => AcquisitionBundle) => setBundle((b) => (b ? fn(b) : b)), []);
  const refreshStatus = useCallback(async () => {
    if (!accountOwnerId) return;
    try { const s = await fetchAcquisitionStatus(id, accountOwnerId); if (s && alive.current) patch((b) => ({ ...b, acquisition: { ...b.acquisition, status: s } })); } catch { /* the badge simply refreshes on the next load */ }
  }, [accountOwnerId, id, patch]);
  const reloadChecks = useCallback(async () => {
    if (!accountOwnerId) return;
    try { const b = await fetchAcquisition(id, accountOwnerId); if (b && alive.current) patch((cur) => ({ ...cur, checks: b.checks })); } catch (e) { toast(describeAcquisitionError(e), 'error'); }
  }, [accountOwnerId, id, patch, toast]);

  const setTab = (t: Tab) => { const next = new URLSearchParams(search); next.set('tab', t); setSearch(next, { replace: true }); };
  const shell = (children: ReactNode) => <DashboardLayout activeLabel="Acquisitions"><div className="mx-auto max-w-6xl space-y-5">{children}</div></DashboardLayout>;

  if (authLoading || profileLoading) return shell(<div aria-busy="true"><SkeletonCardList count={3} /></div>);
  if (!canManage || !accountOwnerId) return shell(<EmptyState icon={Lock} title="You don't have access to Acquisitions" description="Ask your account owner for the “edit business profile” permission." />);
  if (state === 'loading') return shell(<div aria-busy="true"><SkeletonCardList count={4} rows={3} /></div>);
  if (state === 'error') return shell(<InlineError message={error ?? 'Could not load this acquisition.'} onRetry={() => void load()} />);
  if (state === 'missing' || !bundle) {
    return shell(<EmptyState icon={Building2} title="Acquisition not found" description="It may have been deleted, or it belongs to another account." action={{ label: 'Back to Acquisitions', onClick: () => navigate('/dashboard/acquisitions') }} />);
  }

  const a = bundle.acquisition;
  const day = dayNumber(a.close_date, today);
  const members = options?.members ?? [];

  return shell(
    <>
      <div>
        <Link to="/dashboard/acquisitions" className="focus-ring mb-2 inline-flex items-center gap-1 rounded-lg text-xs font-medium text-text-secondary hover:text-text-primary"><ArrowLeft size={12} aria-hidden="true" /> Acquisitions</Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">{a.name}</h1>
            <p className="mt-1 text-sm text-text-secondary">
              {day >= 0 ? `Day ${day}` : `Closes in ${-day} days`} · closed {a.close_date} · {SCOPE_LABELS[a.scope_kind]}
              {a.purchase_price_cents != null && ` · ${formatCents(a.purchase_price_cents, a.currency)}`}
            </p>
          </div>
          <div className="flex gap-2"><Pill tone={a.status === 'completed' ? 'good' : a.status === 'on_hold' ? 'warn' : 'info'}>{STATUS_LABELS[a.status]}</Pill>{(() => { const ph = currentPhase(day); return ph === 'post' || ph === 'pre' ? null : <Pill>{PHASE_LABELS[ph]}</Pill>; })()}</div>
        </div>
      </div>

      <div role="tablist" aria-label="Acquisition sections" className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <button key={t.id} role="tab" type="button" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} onClick={() => setTab(t.id)}
            className={`focus-ring whitespace-nowrap rounded-t-lg px-4 py-2.5 text-sm font-medium ${tab === t.id ? 'border-b-2 border-accent text-accent' : 'text-text-secondary hover:text-text-primary'}`}>{t.label}</button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'plan' && (
          <WorkstreamTracker ownerId={accountOwnerId} acquisitionId={a.id} closeDate={a.close_date} today={today} workstreams={bundle.workstreams} deps={bundle.deps}
            members={members} canManage={canManage}
            onWorkstream={(w) => patch((b) => ({ ...b, workstreams: b.workstreams.map((x) => (x.id === w.id ? w : x)) }))}
            onAdded={(w) => patch((b) => ({ ...b, workstreams: [...b.workstreams, w] }))}
            onRemoved={(wid) => patch((b) => ({ ...b, workstreams: b.workstreams.filter((x) => x.id !== wid), deps: b.deps.filter((d) => d.workstream_id !== wid && d.depends_on_id !== wid) }))}
            onDeps={(deps) => patch((b) => ({ ...b, deps }))}
            onStatusMaybeChanged={() => void refreshStatus()} />
        )}
        {tab === 'dayone' && (
          <DayOneDashboard acquisitionId={a.id} currency={a.currency} report={report} loading={reportState.loading} error={reportState.error} canManage={canManage}
            onRetry={() => void loadReport()} onChanged={() => void loadReport()} />
        )}
        {tab === 'checks' && (
          <DataChecksPanel ownerId={accountOwnerId} acquisition={a} controls={bundle.controls} checks={bundle.checks} importJobs={importJobs} importJobsError={importError}
            linkedImportIds={bundle.linkedImportIds} allLinks={options?.allLinks ?? {}} canManage={canManage}
            onControls={(controls) => patch((b) => ({ ...b, controls }))}
            onLinks={(linkedImportIds) => { patch((b) => ({ ...b, linkedImportIds })); void loadReport(); }}
            onChecksChanged={() => void reloadChecks()} />
        )}
        {tab === 'synergies' && (
          <SynergyPanel ownerId={accountOwnerId} acquisitionId={a.id} currency={a.currency} today={today} synergies={bundle.synergies} actuals={bundle.actuals} canManage={canManage}
            onSynergies={(synergies) => patch((b) => ({ ...b, synergies }))} onActuals={(actuals) => patch((b) => ({ ...b, actuals }))} />
        )}
        {tab === 'settings' && (
          <SettingsTab key={a.id} ownerId={accountOwnerId} bundle={bundle} options={options}
            onSaved={(acquisition) => { patch((b) => ({ ...b, acquisition })); void loadReport(); }}
            onDeleted={() => { toast('Acquisition deleted.', 'success'); navigate('/dashboard/acquisitions'); }} />
        )}
      </div>
    </>,
  );
}

function SettingsTab({ ownerId, bundle, options, onSaved, onDeleted }: {
  ownerId: string; bundle: AcquisitionBundle; options: LinkOptions | null; onSaved: (a: AcquisitionBundle['acquisition']) => void; onDeleted: () => void;
}) {
  const a = bundle.acquisition;
  const { toast } = useToast();
  const [name, setName] = useState(a.name);
  const [status, setStatus] = useState<AcquisitionStatus>(a.status);
  const [brand, setBrand] = useState(a.brand_id ?? '');
  const [location, setLocation] = useState(a.location_id ?? '');
  const [target, setTarget] = useState(String(a.target_jobs_per_tech_day));
  const [notes, setNotes] = useState(a.notes ?? '');
  const [errors, setErrors] = useState<{ name?: string; target?: string }>({});
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const save = async () => {
    const t = Number(target);
    const e: { name?: string; target?: string } = {};
    if (name.trim().length < 1 || name.trim().length > 120) e.name = 'Enter a name up to 120 characters.';
    if (!Number.isFinite(t) || t < 0.5 || t > 20) e.target = 'Use a number between 0.5 and 20.';
    setErrors(e);
    if (e.name || e.target) return;
    setBusy(true);
    try {
      onSaved(await updateAcquisition(a.id, ownerId, { name: name.trim(), status, brand_id: brand || null, location_id: location || null, target_jobs_per_tech_day: t, notes: notes.trim() === '' ? null : notes.trim() }));
      toast('Settings saved.', 'success');
    } catch (err) { toast(describeAcquisitionError(err), 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-5">
      <div className={panelCls}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Name" value={name} maxLength={120} error={errors.name} onChange={(e) => setName(e.target.value)} />
          <Field label="Status">
            <select className={fieldCls} value={status} onChange={(e) => setStatus(e.target.value as AcquisitionStatus)}>
              {EDITABLE_STATUS.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
            <span className="mt-1 block text-xs text-text-secondary">It becomes “Completed” by itself when every workstream is done.</span>
          </Field>
          <Field label="Brand (multi-brand)">
            <select className={fieldCls} value={brand} onChange={(e) => setBrand(e.target.value)}>
              <option value="">None</option>
              {(options?.brands ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <Link to="/dashboard/settings/locations" className="mt-1 inline-block text-xs text-accent hover:underline">Manage brands & locations</Link>
          </Field>
          <Field label="Location">
            <select className={fieldCls} value={location} onChange={(e) => setLocation(e.target.value)}>
              <option value="">None</option>
              {(options?.locations ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
          <Input label="Target jobs per technician-day" inputMode="decimal" value={target} error={errors.target} helperText="Used for the utilization proxy." onChange={(e) => setTarget(e.target.value)} />
        </div>
        <div className="mt-4"><Textarea label="Notes" rows={3} value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} /></div>
        <p className="mt-3 text-xs text-text-secondary">Data source: {SCOPE_LABELS[a.scope_kind]} (set when the acquisition was created).</p>
        <div className="mt-4 flex justify-end"><Button size="sm" onClick={() => void save()} disabled={busy}>{busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Save settings</Button></div>
      </div>
      <div className="rounded-2xl border border-danger/30 p-4 sm:p-5">
        <h3 className="text-sm font-semibold text-danger">Delete acquisition</h3>
        <p className="mt-1 text-sm text-text-secondary">Removes the plan, control totals, check history and synergies. Imported customers and jobs are NOT deleted.</p>
        <div className="mt-3"><Button variant="secondary" size="sm" onClick={() => setConfirm(true)}><Trash2 size={14} aria-hidden="true" /> Delete acquisition</Button></div>
      </div>
      <ConfirmDialog open={confirm} title="Delete this acquisition?" description={`“${a.name}” and its integration plan will be permanently deleted.`} confirmPhrase="delete acquisition" confirmLabel="Delete"
        onCancel={() => setConfirm(false)}
        onConfirm={async () => { setConfirm(false); try { await deleteAcquisition(a.id, ownerId); onDeleted(); } catch (err) { toast(describeAcquisitionError(err), 'error'); } }} />
    </div>
  );
}
