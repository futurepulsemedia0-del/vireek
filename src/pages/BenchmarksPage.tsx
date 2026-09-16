import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { ShieldCheck, Loader as Loader2, TrendingUp, TrendingDown } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { useToast } from '@/contexts/ToastContext';
import {
  fetchBenchmarks,
  computeMyMetrics,
  formatMetricValue,
  percentilePosition,
  metricTier,
  METRIC_META,
  METRIC_ORDER,
  type BenchmarkSnapshot,
  type MetricKey,
} from '@/lib/benchmarks';

const TIER_META = {
  top: { label: 'Top 25%', className: 'bg-success/10 text-success border-success/25' },
  above: { label: 'Above Average', className: 'bg-accent/10 text-accent border-accent/25' },
  below: { label: 'Below Average', className: 'bg-warning-500/10 text-warning-500 border-warning-500/25' },
  bottom: { label: 'Bottom 25%', className: 'bg-danger/10 text-danger border-danger/25' },
} as const;

function MetricCard({ metricKey, mine, snapshot }: { metricKey: MetricKey; mine: number; snapshot: BenchmarkSnapshot }) {
  const meta = METRIC_META[metricKey];
  const hasSpread = snapshot.p25 != null && snapshot.median != null && snapshot.p75 != null;
  const tier = hasSpread ? metricTier(metricKey, mine, snapshot) : 'above';
  const tierMeta = TIER_META[tier];
  const position = hasSpread ? percentilePosition(mine, snapshot.p25!, snapshot.median!, snapshot.p75!) : 50;

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-text-secondary">{meta.label}</p>
          <p className="mt-1 text-2xl font-bold text-text-primary">{formatMetricValue(metricKey, mine)}</p>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold ${tierMeta.className}`}>
          {tier === 'top' || tier === 'above' ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
          {tierMeta.label}
        </span>
      </div>
      {hasSpread && (
        <div className="mt-4">
          <div className="relative h-1.5 rounded-full bg-bg-tertiary">
            <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
            <div className="absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-accent" style={{ left: `${position}%` }} />
          </div>
          <div className="mt-1.5 flex justify-between text-[11px] text-text-secondary">
            <span>P25: {formatMetricValue(metricKey, snapshot.p25!)}</span>
            <span>Median: {formatMetricValue(metricKey, snapshot.median!)}</span>
            <span>P75: {formatMetricValue(metricKey, snapshot.p75!)}</span>
          </div>
        </div>
      )}
      <p className="mt-3 text-[11px] text-text-secondary">Based on {snapshot.sample_size} businesses, last 90 days</p>
    </Card>
  );
}

export function BenchmarksPage() {
  const { toast } = useToast();
  const [benchmarks, setBenchmarks] = useState<BenchmarkSnapshot[]>([]);
  const [mine, setMine] = useState<Partial<Record<MetricKey, number>>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [snapshots, myMetrics] = await Promise.all([fetchBenchmarks(), computeMyMetrics()]);
        setBenchmarks(snapshots);
        setMine(myMetrics);
      } catch {
        toast('Could not load benchmarks — try refreshing', 'error');
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const available = METRIC_ORDER.filter((key) => mine[key] != null && benchmarks.some((b) => b.metric_key === key));

  return (
    <DashboardLayout activeLabel="Benchmarks">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Benchmarks</h1>
          <p className="mt-1 text-sm text-text-secondary">See how your business compares to the Vireek platform — completely anonymous.</p>
        </div>

        <Card className="flex items-start gap-3 !border-accent/20 !bg-accent/5">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
          <p className="text-sm text-text-secondary">
            Every number below is an aggregate across at least 5 businesses — no individual business's data is ever shown,
            and a metric only appears here once enough businesses have contributed to it.
          </p>
        </Card>

        {loading ? (
          <div className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-accent" /></div>
        ) : available.length === 0 ? (
          <Card>
            <p className="py-6 text-center text-sm text-text-secondary">
              Not enough platform-wide data yet to show benchmarks — check back once more businesses are active.
            </p>
          </Card>
        ) : (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {available.map((key) => (
              <MetricCard key={key} metricKey={key} mine={mine[key]!} snapshot={benchmarks.find((b) => b.metric_key === key)!} />
            ))}
          </motion.div>
        )}
      </div>
    </DashboardLayout>
  );
}
