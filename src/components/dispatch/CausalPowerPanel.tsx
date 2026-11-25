import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { assessFeasibility, type PowerVerdict } from '@/lib/causal/power';

interface Props {
  ownerId: string;
  /** Exploration budget (percent) currently configured. */
  budgetPct: number;
}

interface Feasibility {
  decisions_total: number;
  size_distribution: Record<string, number>;
  days: number;
}

const DAYS = 90;
const TONE: Record<PowerVerdict, string> = {
  go: 'border-success/40 bg-success/10',
  marginal: 'border-warning/40 bg-warning/10',
  no_go: 'border-danger/40 bg-danger/10',
  no_data: 'border-border bg-bg-secondary',
};
const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v.trim() !== '' ? Number(v) : fallback);

/** Sizing check: can this account's volume ever teach us anything? Pure calculator in src/lib/causal/power.ts. */
export function CausalPowerPanel({ ownerId, budgetPct }: Props) {
  const [feas, setFeas] = useState<Feasibility | null>(null);
  const [techs, setTechs] = useState('5');
  const [baseline, setBaseline] = useState('80');
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [f, t] = await Promise.all([
          supabase.rpc('dispatch_indifference_feasibility', { p_delta: 3, p_days: DAYS, p_modes: ['auto'] }),
          supabase.from('team_members').select('id', { count: 'exact', head: true }).eq('account_owner_id', ownerId),
        ]);
        if (cancelled) return;
        if (f.error) throw new Error(f.error.message);
        setFeas(f.data as unknown as Feasibility);
        if (typeof t.count === 'number' && t.count > 0) setTechs(String(t.count));
      } catch {
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [ownerId]);

  const result = useMemo(() => {
    if (!feas) return null;
    const dist: Record<number, number> = {};
    for (const [k, v] of Object.entries(feas.size_distribution ?? {})) dist[Number(k)] = Number(v);
    return assessFeasibility({
      technicians: Math.max(1, Math.round(num(techs, 5))),
      jobsPerWeek: (feas.decisions_total ?? 0) / (DAYS / 7),
      setSizeDistribution: dist,
      budgetPct,
      baselineFtf: Math.min(0.99, Math.max(0.01, num(baseline, 80) / 100)),
    });
  }, [feas, techs, baseline, budgetPct]);

  if (loadError) return <p className="text-xs text-text-secondary">Could not load dispatch volume, so the sizing check is unavailable. Leave randomized dispatch off until it is.</p>;
  if (!result) return <p className="text-xs text-text-secondary">Checking whether your volume is large enough…</p>;

  return (
    <div className={`rounded-lg border p-3 text-xs ${TONE[result.verdict]}`} role="status" aria-label="Sizing check for randomized dispatch">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">Is your volume large enough to learn from?</h4>
      <p className="mt-1 text-text-primary">{result.message}</p>
      <div className="mt-2 flex flex-wrap gap-3">
        <label className="flex items-center gap-1 text-text-secondary">Technicians
          <input inputMode="numeric" value={techs} onChange={(e) => setTechs(e.target.value)} className="focus-ring w-14 rounded border border-border bg-bg-primary px-1.5 py-0.5 text-text-primary" />
        </label>
        <label className="flex items-center gap-1 text-text-secondary">Typical first-time fix %
          <input inputMode="numeric" value={baseline} onChange={(e) => setBaseline(e.target.value)} className="focus-ring w-14 rounded border border-border bg-bg-primary px-1.5 py-0.5 text-text-primary" />
        </label>
      </div>
      {result.weeksToTarget !== null && (
        <p className="mt-2 text-text-secondary">
          After 6 months only differences of about {((result.mdeAt26Weeks ?? 0) * 100).toFixed(0)} points or more would show; after a year, {((result.mdeAt52Weeks ?? 0) * 100).toFixed(0)} points.
        </p>
      )}
      <p className="mt-2 text-text-secondary">
        This is an optimistic estimate: it counts every decision with near-equal technicians, before emergency, VIP, SLA and autopilot-hold exclusions remove some of them. It is a planning aid, not a promise.
      </p>
    </div>
  );
}
