import { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Zap, TrendingUp, Clock, Gauge, TriangleAlert as AlertTriangle, ArrowRight } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, Call } from '@/lib/supabase';
import { PRICING_PLANS } from '@/lib/pricing';

// ============================================================
// HELPERS
// ============================================================

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function daysInMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatDayLabel(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', { day: 'numeric' });
}

/** Parses "$0.20/min after" -> 0.2. Returns null for non-metered plans (e.g. Enterprise). */
function parseOverageRate(overage: string | null): number | null {
  if (!overage) return null;
  const match = overage.match(/\$([\d.]+)\/min/);
  return match ? parseFloat(match[1]) : null;
}

const STATUS_LABELS: Record<Call['status'], { label: string; color: string }> = {
  new_lead: { label: 'New Lead', color: 'rgb(var(--accent-primary))' },
  booked: { label: 'Booked', color: 'rgb(var(--success))' },
  missed: { label: 'Missed', color: 'rgb(var(--danger))' },
  callback_requested: { label: 'Callback', color: 'rgb(var(--warning))' },
  spam: { label: 'Spam', color: 'rgb(var(--text-secondary))' },
};

// ============================================================
// SMALL SKELETON / STAT PRIMITIVES
// ============================================================

function SkeletonBlock({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-bg-tertiary ${className}`} />;
}

function StatCard({
  icon: Icon,
  label,
  value,
  sublabel,
  tone = 'default',
}: {
  icon: typeof Zap;
  label: string;
  value: string;
  sublabel?: string;
  tone?: 'default' | 'warning' | 'danger';
}) {
  const toneColor =
    tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning-500' : 'text-text-primary';
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
      <div className="flex items-center gap-2 text-text-secondary">
        <Icon size={15} />
        <span className="text-xs font-medium">{label}</span>
      </div>
      <p className={`mt-2 text-2xl font-bold tracking-tight ${toneColor}`}>{value}</p>
      {sublabel && <p className="mt-1 text-xs text-text-secondary">{sublabel}</p>}
    </div>
  );
}

function ChartCard({ title, insight, children }: { title: string; insight?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
      {insight && <p className="mt-1 text-xs text-text-secondary">{insight}</p>}
      <div className="mt-5">{children}</div>
    </div>
  );
}

// ============================================================
// RADIAL USAGE GAUGE
// ============================================================

function UsageGauge({ pct, unlimited }: { pct: number; unlimited: boolean }) {
  const radius = 70;
  const strokeW = 16;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(100, Math.max(0, pct));
  const dash = unlimited ? circumference : (clamped / 100) * circumference;
  const color = unlimited
    ? 'rgb(var(--success))'
    : clamped >= 90
      ? 'rgb(var(--danger))'
      : clamped >= 75
        ? 'rgb(var(--warning))'
        : 'rgb(var(--accent-primary))';

  return (
    <div className="relative shrink-0">
      <svg width="180" height="180" viewBox="0 0 180 180">
        <g transform="translate(90 90) rotate(-90)">
          <circle r={radius} fill="none" stroke="rgb(var(--bg-tertiary))" strokeWidth={strokeW} />
          <circle
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={strokeW}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circumference - dash}`}
          />
        </g>
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold text-text-primary">{unlimited ? '∞' : `${Math.round(clamped)}%`}</span>
        <span className="text-xs text-text-secondary">{unlimited ? 'unlimited' : 'used'}</span>
      </div>
    </div>
  );
}

// ============================================================
// DAILY USAGE BAR CHART (hand-rolled SVG — no chart dependency)
// ============================================================

function DailyUsageChart({ data }: { data: { date: string; minutes: number }[] }) {
  const chartW = 600;
  const chartH = 180;
  const padding = { top: 10, right: 10, bottom: 22, left: 32 };
  const plotW = chartW - padding.left - padding.right;
  const plotH = chartH - padding.top - padding.bottom;
  const maxVal = Math.max(...data.map((d) => d.minutes), 1);
  const barGap = 2;
  const barW = data.length > 0 ? plotW / data.length - barGap : 0;
  const yTicks = [0, Math.round(maxVal * 0.5), maxVal];

  return (
    <svg viewBox={`0 0 ${chartW} ${chartH}`} className="w-full" style={{ height: chartH }}>
      {yTicks.map((tick) => {
        const y = padding.top + plotH - (tick / maxVal) * plotH;
        return (
          <g key={tick}>
            <line
              x1={padding.left}
              y1={y}
              x2={chartW - padding.right}
              y2={y}
              stroke="rgb(var(--border-default))"
              strokeWidth="1"
              strokeDasharray="2 4"
            />
            <text x={padding.left - 6} y={y + 3} textAnchor="end" fontSize="10" fill="rgb(var(--text-secondary))">
              {tick}
            </text>
          </g>
        );
      })}
      {data.map((d, i) => {
        const x = padding.left + i * (barW + barGap);
        const h = (d.minutes / maxVal) * plotH;
        const y = padding.top + plotH - h;
        return <rect key={d.date} x={x} y={y} width={Math.max(barW, 1)} height={h} rx={1.5} fill="rgb(37 99 235)" />;
      })}
      {data.length > 0 && (
        <>
          <text x={padding.left} y={chartH - 6} textAnchor="start" fontSize="10" fill="rgb(var(--text-secondary))">
            {formatDayLabel(data[0].date)}
          </text>
          <text
            x={chartW - padding.right}
            y={chartH - 6}
            textAnchor="end"
            fontSize="10"
            fill="rgb(var(--text-secondary))"
          >
            {formatDayLabel(data[data.length - 1].date)}
          </text>
        </>
      )}
    </svg>
  );
}

// ============================================================
// CALL OUTCOME BREAKDOWN (segmented bar)
// ============================================================

function OutcomeBreakdownBar({ counts }: { counts: Record<string, number> }) {
  const total = Object.values(counts).reduce((s, v) => s + v, 0);
  if (total === 0) return <p className="text-sm text-text-secondary">No calls yet this month.</p>;

  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-bg-tertiary">
        {(Object.keys(STATUS_LABELS) as Call['status'][]).map((status) => {
          const count = counts[status] ?? 0;
          if (count === 0) return null;
          return (
            <div
              key={status}
              style={{ width: `${(count / total) * 100}%`, backgroundColor: STATUS_LABELS[status].color }}
            />
          );
        })}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {(Object.keys(STATUS_LABELS) as Call['status'][]).map((status) => {
          const count = counts[status] ?? 0;
          if (count === 0) return null;
          return (
            <div key={status} className="flex items-center gap-2 text-xs text-text-secondary">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: STATUS_LABELS[status].color }} />
              {STATUS_LABELS[status].label}
              <span className="font-medium text-text-primary">{count}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// MAIN USAGE DASHBOARD PAGE
// ============================================================

export function UsageDashboardPage() {
  const navigate = useNavigate();
  const { user, profile, profileLoading } = useAuth();

  const [calls, setCalls] = useState<Call[]>([]);
  const [dataLoading, setDataLoading] = useState(true);

  const loadData = useCallback(async () => {
    if (!user) return;
    setDataLoading(true);
    try {
      const monthStartIso = startOfMonth(new Date()).toISOString();
      const { data, error } = await supabase
        .from('calls')
        .select('*')
        .gte('call_datetime', monthStartIso)
        .order('call_datetime', { ascending: true });
      if (!error && data) setCalls(data as Call[]);
    } finally {
      setDataLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!profileLoading && profile && !profile.onboarding_completed) {
      navigate('/onboarding', { replace: true });
    }
  }, [profile, profileLoading, navigate]);

  const now = new Date();
  const totalDaysInMonth = daysInMonth(now);
  const daysElapsed = now.getDate();
  const daysRemaining = totalDaysInMonth - daysElapsed;

  const minutesUsed = profile?.minutes_used_this_month ?? 0;
  const minutesIncluded = profile?.minutes_included ?? 0;
  const unlimited = minutesIncluded <= 0;
  const pctUsed = unlimited ? 0 : (minutesUsed / minutesIncluded) * 100;
  const minutesRemaining = unlimited ? null : Math.max(0, minutesIncluded - minutesUsed);

  const dailyAverage = daysElapsed > 0 ? minutesUsed / daysElapsed : 0;
  const projectedTotal = Math.round(dailyAverage * totalDaysInMonth);
  const projectedOverageMinutes = unlimited ? 0 : Math.max(0, projectedTotal - minutesIncluded);

  const currentPlan = PRICING_PLANS.find((p) => p.id === profile?.plan);
  const overageRate = parseOverageRate(currentPlan?.overage ?? null);
  const projectedOverageCost =
    overageRate !== null && projectedOverageMinutes > 0 ? (projectedOverageMinutes * overageRate).toFixed(2) : null;

  // Daily minutes chart data — every day of the month so far, zero-filled.
  const dailyChartData = useMemo(() => {
    const byDay: Record<string, number> = {};
    calls.forEach((c) => {
      const key = dayKey(new Date(c.call_datetime));
      byDay[key] = (byDay[key] ?? 0) + (c.duration_seconds ?? 0) / 60;
    });
    const days: { date: string; minutes: number }[] = [];
    for (let i = 1; i <= daysElapsed; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), i);
      const key = dayKey(d);
      days.push({ date: key, minutes: Math.round((byDay[key] ?? 0) * 10) / 10 });
    }
    return days;
  }, [calls, daysElapsed, now]);

  const outcomeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    calls.forEach((c) => {
      counts[c.status] = (counts[c.status] ?? 0) + 1;
    });
    return counts;
  }, [calls]);

  return (
    <DashboardLayout activeLabel="Usage Dashboard">
      {/* Page header */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/dashboard')}
          className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
          aria-label="Back to dashboard"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Usage Dashboard</h1>
          <p className="mt-1 text-sm text-text-secondary">
            {now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} · {daysRemaining}{' '}
            {daysRemaining === 1 ? 'day' : 'days'} left in this billing period
          </p>
        </div>
      </div>

      {dataLoading || profileLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
              <SkeletonBlock className="h-4 w-20" />
              <SkeletonBlock className="mt-3 h-7 w-16" />
            </div>
          ))}
        </div>
      ) : (
        <>
          {/* Overage warning */}
          {!unlimited && projectedOverageMinutes > 0 && (
            <div className="mb-5 flex items-start gap-3 rounded-2xl border border-warning-500/30 bg-warning-500/10 p-4">
              <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning-500" />
              <div className="flex-1">
                <p className="text-sm font-medium text-text-primary">
                  On pace to go {projectedOverageMinutes} minutes over your plan this month
                  {projectedOverageCost && ` (~$${projectedOverageCost} in overage)`}.
                </p>
                <p className="mt-0.5 text-xs text-text-secondary">
                  Based on your average of {dailyAverage.toFixed(1)} min/day so far this period.
                </p>
              </div>
              <button
                type="button"
                onClick={() => navigate('/dashboard/billing')}
                className="focus-ring flex shrink-0 items-center gap-1 rounded-lg bg-warning-500/20 px-3 py-1.5 text-xs font-semibold text-warning-500 transition-opacity hover:opacity-80"
              >
                Upgrade <ArrowRight size={13} />
              </button>
            </div>
          )}

          {/* Stat cards */}
          <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              icon={Zap}
              label="Minutes used"
              value={`${Math.round(minutesUsed)}${unlimited ? '' : ` / ${minutesIncluded}`}`}
              sublabel={currentPlan ? `${currentPlan.name} plan` : undefined}
            />
            <StatCard
              icon={Gauge}
              label="Minutes remaining"
              value={unlimited ? 'Unlimited' : `${minutesRemaining}`}
              tone={!unlimited && pctUsed >= 90 ? 'danger' : !unlimited && pctUsed >= 75 ? 'warning' : 'default'}
            />
            <StatCard icon={Clock} label="Daily average" value={`${dailyAverage.toFixed(1)} min`} sublabel={`over ${daysElapsed} days`} />
            <StatCard
              icon={TrendingUp}
              label="Projected month-end"
              value={`${projectedTotal} min`}
              tone={!unlimited && projectedTotal > minutesIncluded ? 'warning' : 'default'}
              sublabel={unlimited ? undefined : `of ${minutesIncluded} included`}
            />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <ChartCard title="Plan usage this period" insight={currentPlan ? `${currentPlan.name} — ${currentPlan.minutes}` : undefined}>
              <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center sm:gap-8">
                <UsageGauge pct={pctUsed} unlimited={unlimited} />
                <div className="flex-1 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Used</span>
                    <span className="font-medium text-text-primary">{Math.round(minutesUsed)} min</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Included</span>
                    <span className="font-medium text-text-primary">{unlimited ? 'Unlimited' : `${minutesIncluded} min`}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Remaining</span>
                    <span className="font-medium text-text-primary">{unlimited ? 'Unlimited' : `${minutesRemaining} min`}</span>
                  </div>
                </div>
              </div>
            </ChartCard>

            <ChartCard title="Calls this month by outcome" insight={`${calls.length} total calls`}>
              <OutcomeBreakdownBar counts={outcomeCounts} />
            </ChartCard>
          </div>

          <div className="mt-5">
            <ChartCard title="Daily usage trend" insight="Minutes of call time per day, this billing period">
              {dailyChartData.every((d) => d.minutes === 0) ? (
                <p className="text-sm text-text-secondary">No call activity recorded yet this period.</p>
              ) : (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
                  <DailyUsageChart data={dailyChartData} />
                </motion.div>
              )}
            </ChartCard>
          </div>
        </>
      )}
    </DashboardLayout>
  );
}
