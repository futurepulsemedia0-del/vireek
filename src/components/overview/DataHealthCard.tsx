import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, DatabaseZap } from 'lucide-react';
import { buildDataHealth } from '@/lib/dataQualityApi';
import { gradeTone } from '@/lib/dataQualityUi';
import { GRADE_LABELS, type DataHealth } from '@/lib/dataQuality';

const CACHE_MS = 5 * 60 * 1000;
let cache: { at: number; health: DataHealth } | null = null;

/** Overview widget: data-health score + the worst open issue. Cached 5 min so the Overview stays light. */
export function DataHealthCard() {
  const [health, setHealth] = useState<DataHealth | null>(cache && Date.now() - cache.at < CACHE_MS ? cache.health : null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (cache && Date.now() - cache.at < CACHE_MS) return;
    let alive = true;
    buildDataHealth()
      .then((h) => { cache = { at: Date.now(), health: h }; if (alive) setHealth(h); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  if (failed) return null;
  if (!health) return <div className="h-28 w-full vrk-skel rounded-xl bg-bg-tertiary" />;

  const worst = health.checks[0];
  return (
    <Link
      to="/dashboard/data-quality"
      className="focus-ring flex h-full items-center gap-4 rounded-xl border border-border bg-bg-secondary p-5 transition-colors hover:border-accent/40"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center text-text-muted"><DatabaseZap size={20} /></span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-text-secondary">Data health</p>
        <p className="mt-0.5 flex items-baseline gap-2">
          <span className={`text-2xl font-semibold tabular-nums ${gradeTone(health.grade)}`}>{health.score}</span>
          <span className="text-sm text-text-secondary">{GRADE_LABELS[health.grade]}</span>
        </p>
        <p className="mt-1 truncate text-xs text-text-secondary">
          {worst ? `${worst.count} · ${worst.title.toLowerCase()}` : 'No data-quality issues found'}
        </p>
      </div>
      <ArrowRight size={16} className="shrink-0 text-text-secondary" />
    </Link>
  );
}
