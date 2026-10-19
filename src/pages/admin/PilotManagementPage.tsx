import { useMemo, useState } from 'react';
import { Pencil, Plus, Rocket, Search, Trash2 } from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { PilotDetailPanel } from '@/components/staff/PilotDetailPanel';
import { PilotFormPanel } from '@/components/staff/PilotFormPanel';
import { PilotMetricsGrid } from '@/components/staff/PilotMetricsGrid';
import { ErrorState, Pill, SelectField, Stat, formatDate, useLoader, type Tone } from '@/components/vehicles/shared';
import { useToast } from '@/contexts/ToastContext';
import { deletePilot, listPilots } from '@/lib/pilotManagementApi';
import {
  PILOT_STATUSES, PILOT_STATUS_LABEL, describeConsent, filterPilots, formatMoney, pilotLabel, summarisePilots,
  type Pilot, type PilotStatus,
} from '@/lib/pilotManagement';
import { useSEO } from '@/lib/seo';

function SEO() {
  useSEO({
    title: 'Pilot Management — Staff',
    description: 'Internal: pilot customers, baseline versus live results and case-study exports.',
    canonical: 'https://vireek.com/staff/pilots',
  });
  return null;
}

const STATUS_TONE: Record<PilotStatus, Tone> = { onboarding: 'info', active: 'success', completed: 'neutral', churned: 'danger' };

type FormState = null | { mode: 'create' } | { mode: 'edit'; pilot: Pilot };

export function PilotManagementPage() {
  const { toast } = useToast();
  const pilots = useLoader(listPilots, 'pilots');

  const [formState, setFormState] = useState<FormState>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Pilot | null>(null);
  const [status, setStatus] = useState<PilotStatus | 'all'>('all');
  const [search, setSearch] = useState('');

  const rows = useMemo(() => pilots.data ?? [], [pilots.data]);
  const summary = useMemo(() => summarisePilots(rows), [rows]);
  const visible = useMemo(() => filterPilots(rows, status, search), [rows, status, search]);

  const onSaved = () => { setFormState(null); void pilots.reload(); };

  const onDelete = async () => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    try {
      await deletePilot(target.id);
      toast(`Pilot for ${pilotLabel(target)} deleted.`, 'success');
      if (selectedId === target.id) setSelectedId(null);
      await pilots.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete the pilot.', 'error');
    }
  };

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen bg-bg-primary px-6 pb-20 pt-28">
        <div className="mx-auto max-w-5xl">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Rocket className="text-accent" size={22} aria-hidden="true" />
              <h1 className="text-2xl font-bold tracking-tight text-text-primary">Pilot Management</h1>
            </div>
            <Button size="sm" onClick={() => { setFormState({ mode: 'create' }); setSelectedId(null); }} disabled={formState?.mode === 'create'}><Plus size={16} /> New pilot</Button>
          </div>
          <p className="mt-2 max-w-2xl text-sm text-text-secondary">
            Track every pilot customer: how they performed before Vireek, how they perform now, the revenue Vireek recovered, and which calls need a look. Export a case study only after the customer has agreed in writing.
          </p>

          {formState && (
            <div className="mt-6">
              <PilotFormPanel
                key={formState.mode === 'edit' ? formState.pilot.id : 'new'}
                pilot={formState.mode === 'edit' ? formState.pilot : null}
                onSaved={onSaved}
                onCancel={() => setFormState(null)}
              />
            </div>
          )}

          {pilots.loading && !pilots.data ? (
            <div className="mt-6"><SkeletonCardList count={3} rows={3} /></div>
          ) : pilots.error && !pilots.data ? (
            <div className="mt-6"><ErrorState message={pilots.error} onRetry={pilots.reload} /></div>
          ) : rows.length === 0 ? (
            formState ? null : (
              <div className="mt-6">
                <EmptyState icon={Rocket} title="No pilots yet" description="Add your first pilot customer, record their baseline, and their results will build up here week by week." action={{ label: 'New pilot', onClick: () => setFormState({ mode: 'create' }) }} />
              </div>
            )
          ) : (
            <>
              {pilots.error && (
                <div role="alert" className="mt-6 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
                  <span>Couldn't refresh: {pilots.error}</span>
                  <Button size="sm" variant="ghost" onClick={pilots.reload}>Retry</Button>
                </div>
              )}

              <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat label="Active pilots" value={`${summary.active} of ${summary.total}`} />
                <Stat label="Revenue recovered" value={formatMoney(summary.recovered_cents)} tone="success" hint="Across all pilots, since each started" />
                <Stat label="Flagged calls" value={summary.flagged_calls} tone={summary.flagged_calls > 0 ? 'warning' : 'neutral'} hint="Open pilots, since start" />
                <Stat label="Ready to export" value={`${summary.export_ready} of ${summary.total}`} hint={`${summary.consent_granted} with consent`} />
              </div>

              <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_200px]">
                <Input label="Search" icon={Search} placeholder="Company or email" value={search} onChange={(e) => setSearch(e.target.value)} />
                <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value as PilotStatus | 'all')}>
                  <option value="all">All statuses</option>
                  {PILOT_STATUSES.map((s) => <option key={s} value={s}>{PILOT_STATUS_LABEL[s]}</option>)}
                </SelectField>
              </div>

              <div className="mt-4">
                {visible.length === 0 ? (
                  <EmptyState icon={Search} title="No pilots match" description="Try a different search or status." action={{ label: 'Clear filters', onClick: () => { setSearch(''); setStatus('all'); } }} />
                ) : (
                  <ul className="space-y-4">
                    {visible.map((p) => {
                      const consent = describeConsent(p.consent.status);
                      const open = selectedId === p.id;
                      return (
                        <li key={p.id} className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <h2 className="break-words text-base font-semibold text-text-primary">{pilotLabel(p)}</h2>
                                <Pill tone={STATUS_TONE[p.status]}>{PILOT_STATUS_LABEL[p.status]}</Pill>
                                <Pill tone={consent.tone}>{consent.label}</Pill>
                              </div>
                              <p className="mt-0.5 break-all text-xs text-text-secondary">
                                {p.tenant_email}{p.plan ? ` · ${p.plan}` : ''} · started {formatDate(p.started_on)}
                                {p.live.weeks_elapsed > 0 ? ` · week ${p.live.weeks_elapsed}` : ''}
                                {p.ended_on ? ` · ended ${formatDate(p.ended_on)}` : ''}
                              </p>
                            </div>
                          </div>

                          <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_220px]">
                            <PilotMetricsGrid pilot={p} />
                            <dl className="grid grid-cols-2 gap-3 self-start lg:grid-cols-1">
                              <div>
                                <dt className="text-xs text-text-secondary">Revenue recovered</dt>
                                <dd className="text-lg font-bold text-success-500">{formatMoney(p.live.recovered_cents)}</dd>
                                <dd className="text-xs text-text-secondary">{p.live.recovered_count} opportunit{p.live.recovered_count === 1 ? 'y' : 'ies'}</dd>
                              </div>
                              <div>
                                <dt className="text-xs text-text-secondary">Flagged calls</dt>
                                <dd className={`text-lg font-bold ${p.live.flagged_calls > 0 ? 'text-warning-500' : 'text-text-primary'}`}>{p.live.flagged_calls}</dd>
                                <dd className="text-xs text-text-secondary">of {p.live.total_calls.toLocaleString('en-US')} calls</dd>
                              </div>
                              <div>
                                <dt className="text-xs text-text-secondary">Average call score</dt>
                                <dd className="text-lg font-bold text-text-primary">{p.live.avg_call_score === null ? '—' : p.live.avg_call_score.toFixed(0)}</dd>
                                <dd className="text-xs text-text-secondary">{p.live.avg_call_score === null ? 'No scored calls' : 'out of 100'}</dd>
                              </div>
                            </dl>
                          </div>

                          <div className="mt-4 flex flex-wrap gap-2">
                            <Button size="sm" variant="secondary" onClick={() => setSelectedId(open ? null : p.id)} aria-expanded={open}>{open ? 'Hide details' : 'Trend, flags & export'}</Button>
                            <Button size="sm" variant="ghost" onClick={() => { setFormState({ mode: 'edit', pilot: p }); window.scrollTo?.({ top: 0, behavior: 'smooth' }); }}><Pencil size={16} /> Edit</Button>
                            <Button size="sm" variant="ghost" onClick={() => setPendingDelete(p)} aria-label={`Delete pilot for ${pilotLabel(p)}`}><Trash2 size={16} /></Button>
                          </div>

                          {open && <PilotDetailPanel pilot={p} onChanged={pilots.reload} />}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </main>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this pilot?"
        description={`This removes the pilot record, its baseline and its consent record for ${pendingDelete ? pilotLabel(pendingDelete) : 'this customer'}. The customer’s calls and jobs are not touched. A deletion entry stays in the audit log.`}
        confirmLabel="Delete pilot"
        onConfirm={onDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}
