import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  BellRing,
  Building2,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Dna,
  Gauge,
  Hammer,
  Hourglass,
  Info,
  PackagePlus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  TrendingUp,
  TriangleAlert,
  Wallet,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { PropertyTwin } from '@/lib/propertyTwin';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CATEGORY_LABELS, HEALTH_CATEGORIES, classifyEquipment } from '@/lib/homeHealthScore';
import { formatBudgetUsd } from '@/lib/homeBudget';
import { formatMonths } from '@/lib/lifetimeServicePlan';
import { fetchSiteYearBuilt } from '@/lib/lifetimeServicePlanApi';
import { fetchEnergyReadings } from '@/lib/homeIntelligenceGraphApi';
import { GRAPH_BASIS_LABELS, GRAPH_RISK_LABELS, type EnergyReading } from '@/lib/homeIntelligenceGraph';
import { deleteGenomeEvent, fetchGenomeEvents, saveGenomeEvent } from '@/lib/homeGenomeApi';
import {
  DEPTH_TIER_LABELS,
  END_OF_LIFE_LABELS,
  EVENT_KIND_LABELS,
  EVENT_NOTE_MAX,
  EVENT_TITLE_MAX,
  MANUAL_EVENT_KINDS,
  PHASE_LABELS,
  SYSTEM_LABELS,
  computeHomeGenome,
  validateGenomeEventInput,
  type EndOfLifeState,
  type GenomeEvent,
  type GenomeEventField,
  type GenomeEventKind,
  type GenomeLayer,
  type GenomeSystem,
  type LayerState,
  type ManualGenomeEvent,
} from '@/lib/homeGenome';

const percent = (value: number) => `${Math.round(value * 100)}%`;
/** The viewer's local calendar date (YYYY-MM-DD), so “today” is selectable in every time zone. */
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const formatDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const TIMELINE_PREVIEW = 8;

const EOL_PILL: Record<EndOfLifeState, string> = {
  none: 'bg-success-500/10 text-success-500',
  approaching: 'bg-warning-500/10 text-warning-500',
  imminent: 'bg-danger/10 text-danger',
  past: 'bg-danger/10 text-danger',
};
const EOL_FILL: Record<EndOfLifeState, string> = {
  none: 'bg-success-500',
  approaching: 'bg-warning-500',
  imminent: 'bg-danger',
  past: 'bg-danger',
};
const EOL_RANK: Record<EndOfLifeState, number> = { past: 0, imminent: 1, approaching: 2, none: 3 };
const STATUS_RANK = { abnormal: 0, watch: 1, normal: 2 } as const;
const LAYER_STYLE: Record<LayerState, string> = {
  recorded: 'border-success-500/30 bg-success-500/5 text-text-primary',
  partial: 'border-warning-500/30 bg-warning-500/5 text-text-primary',
  empty: 'border-border bg-bg-primary text-text-secondary',
};
const KIND_ICON: Record<GenomeEventKind, { icon: LucideIcon; className: string }> = {
  construction: { icon: Building2, className: 'text-text-secondary' },
  install: { icon: PackagePlus, className: 'text-success-500' },
  maintenance: { icon: Wrench, className: 'text-text-secondary' },
  inspection: { icon: ClipboardCheck, className: 'text-text-secondary' },
  repair: { icon: Hammer, className: 'text-warning-500' },
  failure: { icon: TriangleAlert, className: 'text-danger' },
  replacement: { icon: RefreshCw, className: 'text-accent' },
  upgrade: { icon: TrendingUp, className: 'text-accent' },
  warranty: { icon: ShieldCheck, className: 'text-text-secondary' },
  alert: { icon: BellRing, className: 'text-warning-500' },
};
const TONE_CLASS = { neutral: 'border-border bg-bg-secondary text-text-primary', warn: 'border-warning-500/30 bg-warning-500/10 text-warning-500', bad: 'border-danger/30 bg-danger/10 text-danger' } as const;
const SOURCE_LABEL = { site: 'Property record', equipment: 'Equipment record', job: 'Completed job', alert: 'Predictive alert', energy: 'Energy readings', manual: 'Recorded by hand' } as const;

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';

function SelectField({ label, error, children, ...props }: { label: string; error?: string } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <div className="w-full">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">
        {label}
      </label>
      <select id={id} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} className={`${selectClass} ${error ? 'border-danger' : ''}`} {...props}>
        {children}
      </select>
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function Tile({ icon, label, value, note }: { icon: React.ReactNode; label: string; value: string; note: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <div className="mb-1.5 flex items-center gap-1.5 text-text-secondary">
        {icon}
        <span className="text-xs font-medium">{label}</span>
      </div>
      <p className="text-2xl font-semibold leading-none tabular-nums text-text-primary">{value}</p>
      <p className="mt-2 text-[11px] text-text-secondary">{note}</p>
    </div>
  );
}

function StatusPill({ system }: { system: GenomeSystem }) {
  if (system.endOfLife !== 'none') {
    return <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${EOL_PILL[system.endOfLife]}`}>{END_OF_LIFE_LABELS[system.endOfLife]}</span>;
  }
  if (system.status === 'abnormal') return <span className="shrink-0 rounded-full bg-danger/10 px-2.5 py-0.5 text-xs font-medium text-danger">Abnormal behaviour</span>;
  if (system.status === 'watch') return <span className="shrink-0 rounded-full bg-warning-500/10 px-2.5 py-0.5 text-xs font-medium text-warning-500">Early warning</span>;
  return <span className="shrink-0 rounded-full bg-success-500/10 px-2.5 py-0.5 text-xs font-medium text-success-500">Healthy</span>;
}

/** Calendar age as a solid bar; the extra ageing the behaviour implies as a lighter extension. Spans only: it sits inside a button. */
function LifecycleMeter({ system }: { system: GenomeSystem }) {
  if (system.lifeUsed === null || system.behaviorLifeUsed === null) {
    return <span className="block text-[11px] text-text-secondary">{system.ageNote ?? 'Add the install date to measure this unit’s lifecycle.'}</span>;
  }
  const base = Math.min(100, system.lifeUsed * 100);
  const extra = Math.max(0, Math.min(100, system.behaviorLifeUsed * 100) - base);
  const description = `${system.label} lifecycle: ${percent(system.lifeUsed)} of expected life used${extra > 0 ? `, behaving like ${percent(system.behaviorLifeUsed)}` : ''}`;
  return (
    <span className="block">
      <span className="flex h-1.5 w-full overflow-hidden rounded-full bg-border/50" role="img" aria-label={description}>
        <span className={`block h-full ${EOL_FILL[system.endOfLife]}`} style={{ width: `${Math.max(2, base)}%` }} />
        {extra > 0 && <span className="block h-full bg-warning-500/40" style={{ width: `${extra}%` }} />}
      </span>
      <span className="mt-1 block text-[11px] text-text-secondary">
        {PHASE_LABELS[system.phase]} · {system.ageYears?.toFixed(1)} of {system.lifespanYears} years
        {system.effectiveAgeYears !== null && system.ageYears !== null && system.effectiveAgeYears - system.ageYears >= 0.5 ? ` · behaving like ${system.effectiveAgeYears.toFixed(1)} years` : ''}
      </span>
    </span>
  );
}

function Storyline({ system }: { system: GenomeSystem }) {
  if (system.storyline.length === 0) return null;
  return (
    <ol className="flex flex-wrap items-center gap-1.5" aria-label={`${system.label} history`}>
      {system.storyline.map((step, i) => (
        <li key={`${step.year ?? 'now'}-${step.label}-${i}`} className="flex items-center gap-1.5">
          {i > 0 && <ChevronRight size={12} className="text-text-secondary" aria-hidden />}
          <span className={`rounded-lg border px-2 py-1 text-[11px] font-medium ${TONE_CLASS[step.tone]}`}>
            {step.year !== null && <span className="mr-1 tabular-nums opacity-70">{step.year}</span>}
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Timeline({ events, expanded, onToggle, onRemove }: { events: GenomeEvent[]; expanded: boolean; onToggle: () => void; onRemove: (e: GenomeEvent) => void }) {
  const newestFirst = useMemo(() => [...events].reverse(), [events]);
  const shown = expanded ? newestFirst : newestFirst.slice(0, TIMELINE_PREVIEW);
  return (
    <div>
      <ul className="space-y-1.5">
        {shown.map((e) => {
          const { icon: Icon, className } = KIND_ICON[e.kind];
          return (
            <li key={e.id} className="flex items-start gap-3 rounded-lg border border-border bg-bg-secondary px-3 py-2">
              <Icon size={14} className={`mt-0.5 shrink-0 ${className}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-text-primary">
                  {e.title}
                  {e.component && (e.kind === 'failure' || e.kind === 'repair') && <span className="ml-1.5 rounded bg-border/60 px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">{e.component}</span>}
                </p>
                <p className="text-[11px] text-text-secondary">
                  <span className="tabular-nums">{formatDate(e.date)}</span> · {EVENT_KIND_LABELS[e.kind]} · {SOURCE_LABEL[e.source]}
                  {e.costUsd !== null && e.costUsd > 0 ? ` · ${formatBudgetUsd(e.costUsd)}` : ''}
                </p>
                {e.detail && <p className="mt-0.5 text-[11px] text-text-secondary">{e.detail}</p>}
              </div>
              {e.manualId && (
                <button type="button" onClick={() => onRemove(e)} className="focus-ring shrink-0 rounded-md p-1 text-text-secondary hover:text-danger" aria-label={`Remove “${e.title}” from the genome`}>
                  <Trash2 size={13} aria-hidden />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {newestFirst.length > TIMELINE_PREVIEW && (
        <button type="button" onClick={onToggle} className="focus-ring mt-2 text-[11px] font-medium text-accent hover:underline">
          {expanded ? 'Show fewer' : `Show all ${newestFirst.length} events`}
        </button>
      )}
    </div>
  );
}

function SystemDetails({ system, expanded, onToggleTimeline, onRemove }: { system: GenomeSystem; expanded: boolean; onToggleTimeline: () => void; onRemove: (e: GenomeEvent) => void }) {
  const f = system.future;
  return (
    <div className="space-y-4 pt-3">
      <div>
        <p className="text-xs font-semibold text-text-primary">{system.headline}</p>
        {system.reasons.length > 0 && (
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-text-secondary">
            {system.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        {system.ageNote && <p className="mt-1 text-[11px] text-text-secondary">{system.ageNote}</p>}
      </div>

      <Storyline system={system} />

      {system.signals.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">Behaviour signals</p>
          <ul className="space-y-1.5">
            {system.signals.map((s) => (
              <li key={s.key} className="rounded-lg border border-border bg-bg-secondary px-3 py-2">
                <p className="flex items-center gap-1.5 text-xs font-medium text-text-primary">
                  <span className={`inline-block h-1.5 w-1.5 rounded-full ${s.severity === 'high' ? 'bg-danger' : 'bg-warning-500'}`} aria-hidden />
                  {s.title}
                  <span className="sr-only">{s.severity === 'high' ? ' (strong signal)' : ' (early signal)'}</span>
                </p>
                <p className="mt-0.5 text-[11px] text-text-secondary">{s.detail}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ['Repairs & failures', String(system.counts.repair + system.counts.failure)],
          ['Maintenance visits', String(system.counts.maintenance + system.counts.inspection)],
          ['Recorded spend', formatBudgetUsd(system.lifetimeCost)],
          ['Last service', system.lastServiceOn ? formatDate(system.lastServiceOn) : '—'],
        ].map(([term, value]) => (
          <div key={term} className="rounded-lg bg-bg-secondary p-2.5">
            <dt className="text-[10px] font-medium text-text-secondary">{term}</dt>
            <dd className="mt-0.5 text-sm font-semibold tabular-nums text-text-primary">{value}</dd>
          </div>
        ))}
      </dl>

      {f && (
        <div className="rounded-xl border border-border bg-bg-secondary p-3">
          <p className="flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-text-primary">
            <span className="flex items-center gap-1.5">
              <Hourglass size={13} className="text-cta" aria-hidden /> What happens next
            </span>
            <span className="text-[11px] font-normal text-text-secondary">
              {GRAPH_RISK_LABELS[f.level]} risk · {GRAPH_BASIS_LABELS[f.basis]}
            </span>
          </p>
          <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ['Risk, 6 months', percent(f.risk6m)],
              ['Risk, 12 months', percent(f.risk12m)],
              ['Next year, if unchanged', percent(f.riskNextYear)],
              ['Expected cost, 12 months', formatBudgetUsd(f.expectedLoss12m)],
            ].map(([term, value]) => (
              <div key={term} className="rounded-lg bg-bg-primary p-2.5">
                <dt className="text-[10px] font-medium text-text-secondary">{term}</dt>
                <dd className="mt-0.5 text-sm font-semibold tabular-nums text-text-primary">{value}</dd>
              </div>
            ))}
          </dl>
          {f.replaceInMonths !== null && <p className="mt-2 text-[11px] text-text-secondary">Median time to replacement: {f.replaceInMonths <= 0 ? 'now' : `about ${formatMonths(f.replaceInMonths)}`}.</p>}
        </div>
      )}

      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">Genome timeline</p>
        <Timeline events={system.events} expanded={expanded} onToggle={onToggleTimeline} onRemove={onRemove} />
      </div>
    </div>
  );
}

function Strand({ layers }: { layers: GenomeLayer[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5" aria-label="Layers of the home genome">
      {layers.map((l, i) => (
        <li key={l.key} className="flex items-center gap-1.5">
          {i > 0 && <ChevronRight size={12} className="text-text-secondary" aria-hidden />}
          <span className={`rounded-lg border px-2.5 py-1.5 ${LAYER_STYLE[l.state]}`}>
            <span className="block text-[10px] font-medium uppercase tracking-wide text-text-secondary">{l.label}</span>
            <span className="block text-xs font-semibold tabular-nums">{l.value}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

type EventsStatus = 'loading' | 'ready' | 'unavailable';
type FormErrors = Partial<Record<GenomeEventField, string>>;

export function HomeGenomeCard({ twin }: { twin: PropertyTwin }) {
  const { toast } = useToast();
  const siteId = twin.site?.id ?? null;

  const [yearBuilt, setYearBuilt] = useState<number | null>(null);
  const [readings, setReadings] = useState<EnergyReading[]>([]);
  const [recorded, setRecorded] = useState<ManualGenomeEvent[]>([]);
  const [eventsStatus, setEventsStatus] = useState<EventsStatus>('loading');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [fullTimeline, setFullTimeline] = useState<Set<string>>(new Set());
  const [pendingRemoval, setPendingRemoval] = useState<GenomeEvent | null>(null);

  const [target, setTarget] = useState('');
  const [kind, setKind] = useState<string>('repair');
  const [date, setDate] = useState('');
  const [title, setTitle] = useState('');
  const [cost, setCost] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!siteId) return;
    let cancelled = false;
    // Year built, energy and recorded history are optional inputs: if any is unavailable the genome still works from the twin.
    fetchSiteYearBuilt(siteId)
      .then((v) => !cancelled && setYearBuilt(v))
      .catch(() => undefined);
    fetchEnergyReadings(siteId)
      .then((rows) => !cancelled && setReadings(rows))
      .catch(() => undefined);
    setEventsStatus('loading');
    fetchGenomeEvents(siteId)
      .then((rows) => {
        if (cancelled) return;
        setRecorded(rows);
        setEventsStatus('ready');
      })
      .catch(() => !cancelled && setEventsStatus('unavailable'));
    return () => {
      cancelled = true;
    };
  }, [siteId]);

  const genome = useMemo(() => computeHomeGenome(twin, { yearBuilt, energyReadings: readings, manualEvents: recorded }), [twin, yearBuilt, readings, recorded]);

  const units = useMemo(
    () =>
      twin.equipment
        .filter((e) => e.status === 'active')
        .flatMap((e) => {
          const key = classifyEquipment(e);
          return key ? [{ id: e.id, label: `${[e.make, e.model].filter(Boolean).join(' ') || e.equipment_type} — ${CATEGORY_LABELS[key]}` }] : [];
        }),
    [twin.equipment],
  );

  const toggle = useCallback((setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    if (siteId) setRecorded(await fetchGenomeEvents(siteId));
  }, [siteId]);

  const addEvent = useCallback(async () => {
    if (!siteId || saving) return;
    const result = validateGenomeEventInput({ target, kind, date, title, note, cost }, twin.equipment);
    if (!result.ok) {
      setErrors({ [result.field]: result.error });
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      await saveGenomeEvent(siteId, result.value);
      await refresh();
      setTitle('');
      setCost('');
      setNote('');
      setDate('');
      toast('Added to the home genome.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save this event.', 'error');
    } finally {
      setSaving(false);
    }
  }, [siteId, saving, target, kind, date, title, note, cost, twin.equipment, refresh, toast]);

  const confirmRemoval = useCallback(async () => {
    const manualId = pendingRemoval?.manualId;
    if (!manualId) return;
    try {
      await deleteGenomeEvent(manualId);
      await refresh();
      toast('Event removed from the genome.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not remove this event.', 'error');
    } finally {
      setPendingRemoval(null);
    }
  }, [pendingRemoval, refresh, toast]);

  if (!genome) return null;

  const systems = [...genome.systems].sort(
    (a, b) => EOL_RANK[a.endOfLife] - EOL_RANK[b.endOfLife] || STATUS_RANK[a.status] - STATUS_RANK[b.status] || (b.future?.risk12m ?? 0) - (a.future?.risk12m ?? 0),
  );
  const { totals, depth } = genome;
  const nearing = systems.filter((s) => s.endOfLife !== 'none');
  const formReady = eventsStatus === 'ready';

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="mb-4 flex items-start gap-2">
        <Dna size={16} className="mt-0.5 text-cta" aria-hidden />
        <div>
          <p className="text-sm font-semibold text-text-primary">Home Genome</p>
          <p className="text-xs text-text-secondary">
            {genome.homeAgeYears != null ? `${genome.homeAgeYears}-year-old home · ` : ''}How this home has behaved over time — and what that history says will happen next
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile icon={<Gauge size={13} />} label="Genome depth" value={`${depth.score}/100`} note={`${DEPTH_TIER_LABELS[depth.tier]} · grows with every completed job`} />
        <Tile
          icon={<CalendarClock size={13} />}
          label="Documented history"
          value={totals.spanYears !== null ? `${totals.spanYears.toFixed(1)} yrs` : '—'}
          note={`${totals.events} event${totals.events === 1 ? '' : 's'} · ${totals.jobsContributing} job${totals.jobsContributing === 1 ? '' : 's'} contributing`}
        />
        <Tile icon={<Wallet size={13} />} label="Recorded spend" value={formatBudgetUsd(totals.lifetimeCost)} note={`${formatBudgetUsd(totals.spend12m)} in the last 12 months`} />
        <Tile
          icon={<Hourglass size={13} />}
          label="Nearing end of lifecycle"
          value={String(nearing.length)}
          note={nearing.length ? nearing.map((s) => s.label).join(', ') : 'Every recorded system is within its expected life'}
        />
      </div>

      {genome.insights.length > 0 && (
        <div className="mt-5 space-y-2">
          <p className="text-sm font-semibold text-text-primary">What the genome sees</p>
          {genome.insights.map((i) => (
            <button
              key={i.id}
              type="button"
              onClick={() => setOpen((prev) => new Set(prev).add(i.systemKey))}
              className="focus-ring w-full rounded-xl border border-border bg-bg-primary p-3 text-left hover:border-accent/40"
            >
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-text-primary">{i.title}</span>
                <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${i.severity === 'high' ? 'bg-danger/10 text-danger' : 'bg-warning-500/10 text-warning-500'}`}>
                  {i.severity === 'high' ? 'Act soon' : 'Plan ahead'}
                </span>
              </span>
              <span className="mt-1 block text-xs text-text-secondary">{i.body}</span>
            </button>
          ))}
        </div>
      )}

      <div className="mt-6 border-t border-border pt-4">
        <p className="mb-2 text-sm font-semibold text-text-primary">The genome strand</p>
        <Strand layers={genome.layers} />
      </div>

      <div className="mt-6 border-t border-border pt-4">
        <p className="mb-3 text-sm font-semibold text-text-primary">System by system</p>
        {systems.length === 0 ? (
          <p className="rounded-xl border border-border bg-bg-primary p-4 text-xs text-text-secondary">
            The genome starts with the first record. Add the equipment installed here, complete a job, or record past work below, and Vireek begins building this home’s history.
          </p>
        ) : (
          <ul className="space-y-2">
            {systems.map((s) => {
              const isOpen = open.has(s.key);
              return (
                <li key={s.key} className="rounded-xl border border-border bg-bg-primary">
                  <button type="button" onClick={() => toggle(setOpen, s.key)} aria-expanded={isOpen} aria-controls={`hg-${s.key}`} className="focus-ring flex w-full items-center gap-3 p-3 text-left">
                    <span className="min-w-0 flex-1 space-y-2">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="text-sm font-semibold text-text-primary">{s.label}</span>
                        <span className="text-[11px] text-text-secondary">
                          {s.events.length} event{s.events.length === 1 ? '' : 's'}
                          {s.future ? ` · ${percent(s.future.risk12m)} risk in 12 months` : ''}
                        </span>
                      </span>
                      <span className="block">
                        <LifecycleMeter system={s} />
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-2">
                      <StatusPill system={s} />
                      <ChevronDown size={14} className={`text-text-secondary transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden />
                    </span>
                  </button>
                  {isOpen && (
                    <div id={`hg-${s.key}`} className="border-t border-border px-3 pb-3">
                      <SystemDetails system={s} expanded={fullTimeline.has(s.key)} onToggleTimeline={() => toggle(setFullTimeline, s.key)} onRemove={setPendingRemoval} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-2 flex items-center gap-1.5 text-[10px] text-text-secondary">
          <span className="inline-block h-1.5 w-4 rounded-full bg-warning-500/40" aria-hidden />
          Lighter extension = extra ageing implied by repeated problems, overdue service, open alerts or rising energy use
        </p>
      </div>

      {genome.homeEvents.length > 0 && (
        <details className="mt-4 rounded-xl border border-border bg-bg-primary p-3">
          <summary className="cursor-pointer text-xs font-semibold text-text-primary">Whole-home history ({genome.homeEvents.length})</summary>
          <div className="mt-3">
            <Timeline events={genome.homeEvents} expanded={fullTimeline.has('home')} onToggle={() => toggle(setFullTimeline, 'home')} onRemove={setPendingRemoval} />
          </div>
        </details>
      )}

      {genome.forecast.length > 0 && (
        <div className="mt-6 border-t border-border pt-4">
          <p className="mb-2 text-sm font-semibold text-text-primary">Coming up</p>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {genome.forecast.map((f) => (
              <li key={`${f.kind}-${f.label}`} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs">
                <span className="font-medium text-text-primary">{f.kind === 'replacement_window' ? `${f.label} replacement` : f.label}</span>
                <span className="shrink-0 tabular-nums text-text-secondary">{f.inMonths <= 0 ? 'now' : `in about ${formatMonths(f.inMonths)}`}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6 border-t border-border pt-4">
        <p className="text-sm font-semibold text-text-primary">Deepen the genome</p>
        <p className="mb-3 mt-0.5 text-xs text-text-secondary">
          Every completed job is added automatically. Record earlier work — installs, failures, repairs — to extend the history back before this home was on Vireek.
        </p>
        {depth.nextSteps.length > 0 && (
          <ul className="mb-4 list-disc space-y-0.5 pl-4 text-[11px] text-text-secondary">
            {depth.nextSteps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        )}
        {eventsStatus === 'unavailable' ? (
          <p className="rounded-xl border border-border bg-bg-primary p-3 text-[11px] text-text-secondary">Recording past history becomes available after the latest database update is applied.</p>
        ) : (
          <form
            className="grid grid-cols-1 gap-3 rounded-xl border border-border bg-bg-primary p-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              void addEvent();
            }}
          >
            <SelectField label="What was it about?" value={target} onChange={(e) => setTarget(e.target.value)} disabled={!formReady || saving} error={errors.target}>
              <option value="">Choose a unit or system…</option>
              {units.length > 0 && (
                <optgroup label="Units at this property">
                  {units.map((u) => (
                    <option key={u.id} value={`eq:${u.id}`}>
                      {u.label}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Whole systems">
                {[...HEALTH_CATEGORIES, 'home' as const].map((key) => (
                  <option key={key} value={`sys:${key}`}>
                    {SYSTEM_LABELS[key]}
                  </option>
                ))}
              </optgroup>
            </SelectField>
            <SelectField label="What happened?" value={kind} onChange={(e) => setKind(e.target.value)} disabled={!formReady || saving} error={errors.kind}>
              {MANUAL_EVENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {EVENT_KIND_LABELS[k]}
                </option>
              ))}
            </SelectField>
            <Input label="When" type="date" max={today()} value={date} onChange={(e) => setDate(e.target.value)} disabled={!formReady || saving} error={errors.date} />
            <Input label="Cost (optional)" inputMode="decimal" placeholder="e.g. 320" value={cost} onChange={(e) => setCost(e.target.value.replace(/[^\d.]/g, ''))} disabled={!formReady || saving} error={errors.cost} />
            <div className="sm:col-span-2">
              <Input label="Title" placeholder="e.g. Capacitor replaced" maxLength={EVENT_TITLE_MAX} value={title} onChange={(e) => setTitle(e.target.value)} disabled={!formReady || saving} error={errors.title} />
            </div>
            <div className="sm:col-span-2">
              <Textarea label="Note (optional)" rows={2} maxLength={EVENT_NOTE_MAX} placeholder="What failed, what was done, who did it" value={note} onChange={(e) => setNote(e.target.value)} disabled={!formReady || saving} error={errors.note} />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" size="sm" className="w-full sm:w-auto" disabled={!formReady || saving}>
                {saving ? 'Saving…' : 'Add to genome'}
              </Button>
            </div>
          </form>
        )}
      </div>

      <details className="mt-4 text-[11px] text-text-secondary">
        <summary className="flex cursor-pointer items-center gap-1 font-medium text-text-primary">
          <Info size={11} aria-hidden /> How this is built
        </summary>
        <div className="mt-2 space-y-1">
          <p>
            The genome orders everything on file for this property — equipment records, completed jobs, predictive alerts, energy readings and history you add — into one timeline per system, then looks for patterns in it. Forward-looking risk comes from the Home Intelligence Graph.
          </p>
          <ul className="list-disc space-y-0.5 pl-4">
            {genome.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
          <p className="pt-1 font-medium text-text-primary">Genome depth ({depth.score}/100)</p>
          <ul className="list-disc space-y-0.5 pl-4">
            {depth.parts.map((p) => (
              <li key={p.key}>
                {p.label}: {p.score}/{p.max}
              </li>
            ))}
          </ul>
        </div>
      </details>

      <ConfirmDialog
        open={pendingRemoval !== null}
        title="Remove this event?"
        description={pendingRemoval ? `“${pendingRemoval.title}” (${formatDate(pendingRemoval.date)}) will be removed from this home’s genome. Events from jobs and equipment records are not affected.` : ''}
        confirmLabel="Remove event"
        onConfirm={confirmRemoval}
        onCancel={() => setPendingRemoval(null)}
      />
    </div>
  );
}
