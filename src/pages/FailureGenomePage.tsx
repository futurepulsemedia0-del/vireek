import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, Dna, ShieldCheck, Trash2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { GenomeStrip } from '@/components/failure-genome/GenomeStrip';
import { LogFailureForm } from '@/components/failure-genome/LogFailureForm';
import { PatternCard } from '@/components/failure-genome/PatternCard';
import {
  CLIMATE_OPTIONS,
  OUTCOME_META,
  SELECT_CLASS,
  USAGE_OPTIONS,
  deleteFailureEvent,
  fetchEvents,
  fetchPatternExposure,
  fetchSharing,
  fetchUnits,
  humanize,
  missingProfileFields,
  saveSharing,
  unitLabel,
  updateEquipmentProfile,
  type ClimateZone,
  type ExposureRow,
  type FailureEventRow,
  type UnitRow,
  type UsageProfile,
} from '@/lib/failureGenome';

type Tab = 'patterns' | 'units' | 'log';

const TABS: { id: Tab; label: string }[] = [
  { id: 'patterns', label: 'Emerging patterns' },
  { id: 'units', label: 'Unit genomes' },
  { id: 'log', label: 'Log a failure' },
];

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {hint && <p className="mt-1 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

function UnitCard({
  unit,
  onProfileChange,
  onLog,
  onChanged,
}: {
  unit: UnitRow;
  onProfileChange: (id: string, patch: { climate_zone?: ClimateZone | null; usage_profile?: UsageProfile | null }) => void;
  onLog: (id: string) => void;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<FailureEventRow[] | null>(null);
  const dna = unit.genome?.dna ?? null;
  const missing = dna ? missingProfileFields(dna) : [];
  const computedAt = unit.genome?.computed_at;

  useEffect(() => { setEvents(null); }, [computedAt]);

  useEffect(() => {
    if (!open || events) return;
    fetchEvents(unit.id).then(setEvents).catch(() => setEvents([]));
  }, [open, events, unit.id]);

  const remove = async (id: string) => {
    if (!window.confirm('Delete this failure event? The unit genome will be recalculated.')) return;
    try {
      await deleteFailureEvent(id);
      onChanged();
    } catch {
      toast('Could not delete this event.', 'error');
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">{unitLabel(unit)}</h3>
          <p className="text-xs text-text-secondary">{humanize(unit.equipment_type)}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => onLog(unit.id)}>Log failure</Button>
          <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            History <ChevronDown size={14} className={open ? 'rotate-180 transition-transform' : 'transition-transform'} aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div className="mt-3">{dna ? <GenomeStrip dna={dna} /> : <Skeleton className="h-16 w-full rounded-xl" />}</div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <select
          aria-label="Climate"
          value={unit.climate_zone ?? ''}
          onChange={(e) => onProfileChange(unit.id, { climate_zone: (e.target.value || null) as ClimateZone | null })}
          className={SELECT_CLASS}
        >
          <option value="">Climate: not set</option>
          {CLIMATE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select
          aria-label="Usage"
          value={unit.usage_profile ?? ''}
          onChange={(e) => onProfileChange(unit.id, { usage_profile: (e.target.value || null) as UsageProfile | null })}
          className={SELECT_CLASS}
        >
          <option value="">Usage: not set</option>
          {USAGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      {missing.length > 0 && (
        <p className="mt-2 text-xs text-text-secondary">
          Set {missing.join(' & ')} to place this unit in a sharper population cohort.
        </p>
      )}

      {open && (
        <div className="mt-4 space-y-2 border-t border-border pt-4">
          {events === null ? (
            <Skeleton className="h-10 w-full" />
          ) : events.length === 0 ? (
            <p className="text-sm text-text-secondary">This unit has a clean record so far.</p>
          ) : (
            events.map((ev) => (
              <div key={ev.id} className="flex items-start justify-between gap-3 rounded-xl bg-bg-primary px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text-primary">
                    {humanize(ev.failure_component)}
                    {ev.failure_mode ? ` · ${humanize(ev.failure_mode).toLowerCase()}` : ''}
                  </p>
                  <p className="text-xs text-text-secondary">
                    {ev.occurred_on}
                    {ev.repair_action ? ` · ${humanize(ev.repair_action)}` : ''}
                    {ev.parts_replaced.length > 0 ? ` · ${ev.parts_replaced.map(humanize).join(', ')}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${OUTCOME_META[ev.outcome].className}`}>
                    {OUTCOME_META[ev.outcome].label}
                  </span>
                  <button
                    type="button"
                    onClick={() => remove(ev.id)}
                    aria-label="Delete failure event"
                    className="focus-ring rounded-lg p-1.5 text-text-secondary hover:text-danger-500"
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function FailureGenomePage() {
  const { user, isOwner } = useAuth();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('patterns');
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [loadingUnits, setLoadingUnits] = useState(true);
  const [exposure, setExposure] = useState<ExposureRow[]>([]);
  const [loadingPatterns, setLoadingPatterns] = useState(true);
  const [patternsFailed, setPatternsFailed] = useState(false);
  const [sharing, setSharingState] = useState<boolean | null>(null);
  const [showStable, setShowStable] = useState(false);
  const [unitFilter, setUnitFilter] = useState<string[] | null>(null);
  const [logFor, setLogFor] = useState('');

  const loadUnits = useCallback(async () => {
    try {
      setUnits(await fetchUnits());
    } catch {
      toast('Could not load your equipment genomes.', 'error');
    } finally {
      setLoadingUnits(false);
    }
  }, [toast]);

  const loadPatterns = useCallback(async () => {
    setLoadingPatterns(true);
    setPatternsFailed(false);
    try {
      setExposure(await fetchPatternExposure(showStable));
    } catch {
      setPatternsFailed(true);
    } finally {
      setLoadingPatterns(false);
    }
  }, [showStable]);

  useEffect(() => { loadUnits(); }, [loadUnits]);
  useEffect(() => { loadPatterns(); }, [loadPatterns]);
  useEffect(() => { fetchSharing().then(setSharingState).catch(() => setSharingState(null)); }, []);

  const toggleSharing = async () => {
    if (sharing === null || !user) return;
    const next = !sharing;
    try {
      await saveSharing(user.id, next);
      setSharingState(next);
      toast(next ? 'Pattern sharing is on.' : 'Pattern sharing is off - your units no longer feed or receive population patterns.', 'success');
      loadPatterns();
    } catch {
      toast('Could not update the sharing setting.', 'error');
    }
  };

  const changeProfile = async (id: string, patch: { climate_zone?: ClimateZone | null; usage_profile?: UsageProfile | null }) => {
    try {
      await updateEquipmentProfile(id, patch);
      await loadUnits();
    } catch {
      toast('Could not update this unit.', 'error');
    }
  };

  const openLog = (id: string) => { setLogFor(id); setTab('log'); };

  const emerging = exposure.filter((r) => r.pattern.status === 'emerging');
  const affectedUnits = useMemo(() => new Set(emerging.flatMap((r) => r.my_equipment_ids)).size, [emerging]);
  const withHistory = units.filter((u) => (u.genome?.failure_count ?? 0) > 0).length;
  const profileDone = units.length === 0
    ? 0
    : Math.round((units.reduce((s, u) => s + (u.genome ? 4 - missingProfileFields(u.genome.dna).length : 0), 0) / (units.length * 4)) * 100);
  const visibleUnits = unitFilter ? units.filter((u) => unitFilter.includes(u.id)) : units;

  return (
    <DashboardLayout activeLabel="Failure Genome">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Dna size={24} aria-hidden="true" /></span>
        <div>
          <h1 className="text-xl font-bold text-text-primary">Vireek Failure Genome</h1>
          <p className="text-sm text-text-secondary">
            A failure DNA for every unit - and early warning when a failure pattern starts growing across a population of equipment.
          </p>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Units sequenced" value={String(units.length)} />
        <Kpi label="Units with failure history" value={String(withHistory)} />
        <Kpi label="Profile completeness" value={`${profileDone}%`} hint="Model, age, climate, usage" />
        <Kpi label="Your units in emerging patterns" value={String(affectedUnits)} />
      </div>

      <div role="tablist" aria-label="Failure Genome sections" className="mb-5 flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`focus-ring -mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              tab === t.id ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'patterns' && (
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input type="checkbox" checked={showStable} onChange={(e) => setShowStable(e.target.checked)} />
            Also show stable and declining patterns
          </label>

          {loadingPatterns ? (
            <div className="space-y-3"><Skeleton className="h-40 w-full rounded-2xl" /><Skeleton className="h-40 w-full rounded-2xl" /></div>
          ) : patternsFailed ? (
            <p className="rounded-2xl border border-border bg-bg-secondary p-5 text-sm text-text-secondary">
              Could not load population patterns. Check that the Failure Genome migration has been applied, then retry.
            </p>
          ) : sharing === false ? (
            <EmptyState
              icon={ShieldCheck}
              title="Pattern sharing is off"
              description="Turn sharing on to contribute anonymous genome signals and see when a failure pattern emerges in equipment like yours."
              action={isOwner ? { label: 'Turn on sharing', onClick: toggleSharing } : undefined}
            />
          ) : exposure.length === 0 ? (
            <EmptyState
              icon={Dna}
              title="Nothing emerging in your fleet"
              description="Patterns appear once at least 5 businesses report similar failures on the same model. Keep logging failures to strengthen detection."
              action={{ label: 'Log a failure', onClick: () => openLog('') }}
            />
          ) : (
            exposure.map((r) => (
              <PatternCard key={r.pattern.id} row={r} onViewUnits={(ids) => { setUnitFilter(ids); setTab('units'); }} />
            ))
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-bg-secondary p-5">
            <p className="max-w-2xl text-xs text-text-secondary">
              Population patterns are built only from aggregates: a pattern needs at least 5 contributing businesses, no single business
              supplies more than 60% of its events, and customer names, addresses, serial numbers, notes and job details are never included.
            </p>
            {isOwner && sharing !== null && (
              <Button variant="secondary" size="sm" onClick={toggleSharing}>
                {sharing ? 'Stop sharing' : 'Start sharing'}
              </Button>
            )}
          </div>
        </div>
      )}

      {tab === 'units' && (
        <div className="space-y-4">
          {unitFilter && (
            <div className="flex items-center justify-between rounded-xl border border-accent/30 bg-accent/5 px-4 py-2.5">
              <p className="text-sm text-text-primary">Showing {unitFilter.length} unit{unitFilter.length === 1 ? '' : 's'} in the selected pattern.</p>
              <Button variant="ghost" size="sm" onClick={() => setUnitFilter(null)}>Show all</Button>
            </div>
          )}
          {loadingUnits ? (
            <div className="space-y-3"><Skeleton className="h-48 w-full rounded-2xl" /><Skeleton className="h-48 w-full rounded-2xl" /></div>
          ) : visibleUnits.length === 0 ? (
            <EmptyState
              icon={Dna}
              title="No equipment to sequence"
              description="Add equipment to a customer record and Vireek builds its failure genome automatically."
            />
          ) : (
            visibleUnits.map((u) => <UnitCard key={u.id} unit={u} onProfileChange={changeProfile} onLog={openLog} onChanged={loadUnits} />)
          )}
        </div>
      )}

      {tab === 'log' && (
        <LogFailureForm
          key={logFor}
          units={units}
          initialEquipmentId={logFor}
          onLogged={(id) => { loadUnits(); loadPatterns(); setUnitFilter([id]); setTab('units'); }}
        />
      )}
    </DashboardLayout>
  );
}
