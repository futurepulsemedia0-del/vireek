import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Building2, ChevronDown, Loader2, RefreshCw, Radar } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import type { Job } from '@/lib/supabase';
import {
  HEATING_FUELS,
  NODE_TEXT,
  PROPERTY_TYPES,
  RISK_META,
  SEVERITY_META,
  fetchLatestJobContext,
  fetchPropertyProfile,
  humanize,
  isStale,
  requestJobContext,
  savePropertyProfile,
  type ContextNode,
  type JobContextSnapshot,
} from '@/lib/jobContext';

const CLOSED = new Set(['completed', 'cancelled', 'no_show']);

/** Radial Context Graph: the job in the center, every real-world factor around it. */
function ContextGraphView({ nodes }: { nodes: ContextNode[] }) {
  const outer = nodes.filter((n) => n.id !== 'job');
  const center = { x: 180, y: 150 };
  const radius = 108;
  const pos = (i: number) => {
    const a = (i / Math.max(outer.length, 1)) * Math.PI * 2 - Math.PI / 2;
    return { x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) };
  };
  return (
    <svg viewBox="0 0 360 300" className="mx-auto h-auto w-full max-w-md" role="img" aria-label="Context graph of the real-world factors around this job">
      {outer.map((n, i) => {
        const p = pos(i);
        return <line key={`l-${n.id}`} x1={center.x} y1={center.y} x2={p.x} y2={p.y} className="stroke-border" strokeWidth={1.5} />;
      })}
      <g className="text-accent">
        <circle cx={center.x} cy={center.y} r={22} fill="currentColor" fillOpacity={0.12} stroke="currentColor" strokeWidth={2} />
        <text x={center.x} y={center.y + 3} textAnchor="middle" className="fill-current text-[9px] font-semibold">JOB</text>
      </g>
      {outer.map((n, i) => {
        const p = pos(i);
        const label = n.label.length > 18 ? `${n.label.slice(0, 17)}…` : n.label;
        return (
          <g key={n.id} className={NODE_TEXT[n.status]}>
            <title>{`${n.label} — ${n.detail}`}</title>
            <circle cx={p.x} cy={p.y} r={13} fill="currentColor" fillOpacity={n.status === 'unknown' ? 0.06 : 0.16} stroke="currentColor" strokeWidth={2} strokeDasharray={n.status === 'unknown' ? '3 3' : undefined} />
            <text x={p.x} y={p.y > center.y ? p.y + 26 : p.y - 19} textAnchor="middle" className="fill-text-primary text-[9px]">
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function PropertyEditor({ job, onSaved }: { job: Job; onSaved: () => void }) {
  const { toast } = useToast();
  const [year, setYear] = useState('');
  const [sqft, setSqft] = useState('');
  const [type, setType] = useState('');
  const [fuel, setFuel] = useState('');
  const [provider, setProvider] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!job.customer_id) return;
    let alive = true;
    fetchPropertyProfile(job.customer_id, job.site_id ?? null)
      .then((p) => {
        if (!alive || !p) return;
        setYear(p.year_built?.toString() ?? '');
        setSqft(p.square_feet?.toString() ?? '');
        setType(p.property_type ?? '');
        setFuel(p.heating_fuel ?? '');
        setProvider(p.utility_provider ?? '');
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [job.customer_id, job.site_id]);

  if (!job.customer_id) {
    return <p className="text-xs text-text-secondary">Link this job to a customer to store property details.</p>;
  }

  const save = async () => {
    const y = year ? Number(year) : null;
    const s = sqft ? Number(sqft) : null;
    if ((y !== null && (!Number.isInteger(y) || y < 1700 || y > 2100)) || (s !== null && (!Number.isInteger(s) || s < 100))) {
      toast('Check the year built and square footage.', 'error');
      return;
    }
    setSaving(true);
    try {
      await savePropertyProfile({
        customer_id: job.customer_id as string,
        site_id: job.site_id ?? null,
        year_built: y,
        square_feet: s,
        property_type: type || null,
        heating_fuel: fuel || null,
        utility_provider: provider || null,
      });
      toast('Property details saved', 'success');
      onSaved();
    } catch {
      toast('Could not save property details', 'error');
    } finally {
      setSaving(false);
    }
  };

  const selectClass =
    'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus-visible:border-accent';

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Input id={`ctx-year-${job.id}`} label="Year built" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))} />
      <Input id={`ctx-sqft-${job.id}`} label="Square feet" inputMode="numeric" value={sqft} onChange={(e) => setSqft(e.target.value.replace(/\D/g, '').slice(0, 7))} />
      <div>
        <label htmlFor={`ctx-type-${job.id}`} className="mb-1.5 block text-sm font-medium text-text-primary">Property type</label>
        <select id={`ctx-type-${job.id}`} className={selectClass} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">Unknown</option>
          {PROPERTY_TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor={`ctx-fuel-${job.id}`} className="mb-1.5 block text-sm font-medium text-text-primary">Heating fuel</label>
        <select id={`ctx-fuel-${job.id}`} className={selectClass} value={fuel} onChange={(e) => setFuel(e.target.value)}>
          <option value="">Unknown</option>
          {HEATING_FUELS.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}
        </select>
      </div>
      <div className="sm:col-span-2">
        <Input id={`ctx-util-${job.id}`} label="Utility provider" maxLength={120} value={provider} onChange={(e) => setProvider(e.target.value)} />
      </div>
      <div className="sm:col-span-2">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : null}
          Save property details
        </Button>
      </div>
    </div>
  );
}

export function JobContextPanel({ job }: { job: Job }) {
  const { toast } = useToast();
  const [snapshot, setSnapshot] = useState<JobContextSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [showProperty, setShowProperty] = useState(false);
  const closed = CLOSED.has(job.job_status);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchLatestJobContext(job.id)
      .then((s) => alive && setSnapshot(s))
      .catch(() => undefined)
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [job.id]);

  const build = useCallback(
    async (force: boolean) => {
      setBuilding(true);
      try {
        const res = await requestJobContext(job.id, { force });
        setSnapshot(res.snapshot);
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Could not build the job context.', 'error');
      } finally {
        setBuilding(false);
      }
    },
    [job.id, toast],
  );

  const stale = snapshot ? isStale(snapshot) : false;
  const missing = useMemo(() => (snapshot ? Object.entries(snapshot.sources).filter(([, v]) => v === 'missing').map(([k]) => humanize(k)) : []), [snapshot]);

  return (
    <section className="rounded-xl border border-border bg-bg-primary p-4" aria-label="Real-World Context">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Radar size={16} className="text-accent" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-text-primary">Real-World Context</h3>
        </div>
        {!closed && (
          <Button size="sm" variant="secondary" onClick={() => build(snapshot !== null)} disabled={building || loading}>
            {building ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {snapshot ? 'Refresh' : 'Build context'}
          </Button>
        )}
      </div>

      {loading && <p className="mt-3 text-xs text-text-secondary">Loading…</p>}

      {!loading && !snapshot && (
        <p className="mt-3 text-xs text-text-secondary">
          {closed ? 'This job is closed.' : 'Understand the real situation before the technician leaves: weather, property, equipment, history, permits, parts and technician fit.'}
        </p>
      )}

      {snapshot && (
        <div className="mt-4 space-y-4">
          <div className="flex items-center gap-4">
            <div className={`flex h-16 w-16 shrink-0 flex-col items-center justify-center rounded-full border-2 border-current ${RISK_META[snapshot.risk_level].text}`} aria-label={`Readiness ${snapshot.readiness_score} out of 100`}>
              <span className="text-xl font-bold leading-none">{snapshot.readiness_score}</span>
              <span className="text-[9px] uppercase tracking-wide">ready</span>
            </div>
            <div className="min-w-0">
              <p className={`text-sm font-semibold ${RISK_META[snapshot.risk_level].text}`}>{RISK_META[snapshot.risk_level].label}</p>
              <p className="text-xs text-text-secondary">
                Context coverage {snapshot.coverage_pct}% · built {new Date(snapshot.generated_at).toLocaleString()}
                {stale ? ' · out of date, refresh before dispatch' : ''}
              </p>
            </div>
          </div>

          {snapshot.brief && (
            <div className="rounded-lg border border-border p-3 text-sm text-text-primary">
              <p>{snapshot.brief.summary}</p>
              {snapshot.brief.tech_prep.length > 0 && (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-text-secondary">
                  {snapshot.brief.tech_prep.map((t) => <li key={t}>{t}</li>)}
                </ul>
              )}
              {snapshot.brief.customer_note && <p className="mt-2 text-xs text-text-secondary">Tell the customer: {snapshot.brief.customer_note}</p>}
              {snapshot.brief.questions.length > 0 && (
                <p className="mt-2 text-xs text-text-secondary">Ask before arrival: {snapshot.brief.questions.join(' · ')}</p>
              )}
            </div>
          )}
          {snapshot.ai_status === 'unavailable' && <p className="text-xs text-text-secondary">The AI brief is unavailable right now. The graph and flags below are still complete.</p>}

          <ContextGraphView nodes={snapshot.nodes} />

          {snapshot.flags.length > 0 ? (
            <ul className="space-y-2">
              {snapshot.flags.map((f) => (
                <li key={`${f.code}-${f.node}`} className="rounded-lg border border-border p-3">
                  <p className="flex items-center gap-2 text-sm font-medium text-text-primary">
                    <AlertTriangle size={14} className={SEVERITY_META[f.severity].text} aria-hidden="true" />
                    {f.title}
                    <span className={`ml-auto text-[10px] font-semibold uppercase ${SEVERITY_META[f.severity].text}`}>{SEVERITY_META[f.severity].label}</span>
                  </p>
                  <p className="mt-1 text-xs text-text-secondary">{f.detail}</p>
                  <p className="mt-1 text-xs text-text-primary">→ {f.action}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-text-secondary">No risks found in the available context.</p>
          )}

          {missing.length > 0 && <p className="text-xs text-text-secondary">Missing context: {missing.join(', ')}.</p>}
        </div>
      )}

      <button
        type="button"
        onClick={() => setShowProperty((v) => !v)}
        className="focus-ring mt-4 flex w-full items-center justify-between rounded-lg px-1 py-1 text-xs font-medium text-text-secondary hover:text-text-primary"
        aria-expanded={showProperty}
      >
        <span className="flex items-center gap-2"><Building2 size={14} aria-hidden="true" /> Property details</span>
        <ChevronDown size={14} className={`transition-transform ${showProperty ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {showProperty && (
        <div className="mt-3">
          <PropertyEditor job={job} onSaved={() => (closed ? undefined : void build(true))} />
        </div>
      )}
    </section>
  );
}
