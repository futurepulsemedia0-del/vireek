import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, MapPin, RefreshCw, TrendingUp, TrendingDown, Sparkles } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  fetchMyBusinessSegment, fetchRegionalSnapshot, computeMyLocalDemand, fetchRegionalInsights,
  MyLocalDemand, RegionalDemandSnapshot, RegionalInsight,
} from '@/lib/regionalDemand';

function ChangeBadge({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-xs text-text-secondary">no prior data</span>;
  const up = pct >= 0;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${up ? 'bg-emerald-500/10 text-emerald-500' : 'bg-danger/10 text-danger'}`}>
      {up ? <TrendingUp size={12} /> : <TrendingDown size={12} />} {Math.abs(pct)}%
    </span>
  );
}

export function RegionalDemandPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [segment, setSegment] = useState<{ service_area: string | null; primary_industry: string | null } | null>(null);
  const [regional, setRegional] = useState<RegionalDemandSnapshot | null>(null);
  const [myLocal, setMyLocal] = useState<MyLocalDemand | null>(null);
  const [insights, setInsights] = useState<RegionalInsight[]>([]);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const seg = await fetchMyBusinessSegment();
    setSegment(seg);
    const [local, region] = await Promise.all([
      computeMyLocalDemand(),
      seg.service_area && seg.primary_industry ? fetchRegionalSnapshot(seg.service_area, seg.primary_industry) : Promise.resolve(null),
    ]);
    setMyLocal(local);
    setRegional(region);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAnalyze = async () => {
    if (!myLocal) return;
    setAnalyzing(true);
    try {
      const { insights: result, region } = await fetchRegionalInsights(myLocal);
      setInsights(result);
      if (region) setRegional(region);
      if (result.length === 0) toast('No notable regional signal right now.', 'info');
    } catch {
      toast('Could not analyze regional demand. Please try again.', 'error');
    } finally {
      setAnalyzing(false);
    }
  };

  const myChangePct = myLocal && myLocal.prior_week_calls > 0
    ? Math.round(((myLocal.current_week_calls - myLocal.prior_week_calls) / myLocal.prior_week_calls) * 1000) / 10
    : null;

  return (
    <DashboardLayout activeLabel="Regional Demand">
      <button type="button" onClick={() => navigate('/dashboard')} className="focus-ring mb-5 flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary">
        <ArrowLeft size={16} /> Back to dashboard
      </button>

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <MapPin size={24} />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Regional Demand Intelligence</h1>
            <p className="text-sm text-text-secondary">Your own local demand, plus an anonymized signal from similar businesses in your area.</p>
          </div>
        </div>
        <button onClick={handleAnalyze} disabled={analyzing || !myLocal} className="focus-ring flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60">
          <Sparkles size={16} className={analyzing ? 'animate-pulse' : ''} /> Get AI Take
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-border bg-bg-secondary p-5">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-text-secondary">Your business (last 7 days)</h2>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold text-text-primary">{myLocal?.current_week_calls ?? 0}</span>
                <span className="text-sm text-text-secondary">calls</span>
                <ChangeBadge pct={myChangePct} />
              </div>
              <p className="mt-1 text-sm text-text-secondary">{myLocal?.current_week_leads ?? 0} new leads this week</p>
            </div>

            <div className="rounded-2xl border border-border bg-bg-secondary p-5">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-text-secondary">
                Businesses like yours in "{segment?.service_area ?? 'your area'}"
              </h2>
              {regional ? (
                <>
                  <div className="flex items-baseline gap-2">
                    <span className="text-3xl font-bold text-text-primary">{regional.current_week_calls}</span>
                    <span className="text-sm text-text-secondary">calls (region total)</span>
                    <ChangeBadge pct={regional.call_volume_change_pct} />
                  </div>
                  <p className="mt-1 text-sm text-text-secondary">
                    {regional.emergency_rate_pct ?? 0}% emergency calls · based on {regional.sample_size} businesses
                  </p>
                </>
              ) : (
                <p className="text-sm text-text-secondary">
                  Not enough businesses share your exact service area + industry yet (need at least 5) — set a specific Service Area in Business Profile to join a comparison group.
                </p>
              )}
            </div>
          </div>

          {insights.length > 0 && (
            <div className="space-y-3">
              {insights.map((ins, i) => (
                <div key={i} className="rounded-2xl border border-border border-l-4 border-l-accent bg-bg-secondary p-4">
                  <h3 className="font-semibold text-text-primary">{ins.title}</h3>
                  <p className="mt-1 text-sm text-text-secondary">{ins.description}</p>
                  <p className="mt-2 rounded-lg bg-bg-primary p-2.5 text-sm text-text-primary"><strong>Do:</strong> {ins.recommended_action}</p>
                </div>
              ))}
            </div>
          )}

          <div className="rounded-2xl border border-border bg-bg-secondary p-5">
            <h2 className="mb-3 text-lg font-semibold text-text-primary">Where your demand is coming from</h2>
            {!myLocal?.top_localities.length ? (
              <p className="text-sm text-text-secondary">Not enough job addresses with a city/area yet to build a breakdown.</p>
            ) : (
              <div className="space-y-2">
                {myLocal.top_localities.map((l) => (
                  <div key={l.name} className="flex items-center justify-between rounded-lg border border-border p-3 text-sm">
                    <span className="font-medium text-text-primary">{l.name}</span>
                    <span className="flex items-center gap-2 text-text-secondary">{l.current_week} this week <ChangeBadge pct={l.change_pct} /></span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
