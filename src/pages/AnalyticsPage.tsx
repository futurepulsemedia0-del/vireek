import { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  Download,
  Calendar,
  TrendingUp,
  TriangleAlert as AlertTriangle,
  Lightbulb,
  ChevronDown,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, Call, Job, Lead } from '@/lib/supabase';
import { useKeyboardShortcut } from '@/lib/hooks';
import { Lock } from 'lucide-react';

// ============================================================
// TYPES
// ============================================================

type DateRange = '7d' | '30d' | '90d' | 'custom';

interface DateRangeState {
  preset: DateRange;
  start: Date;
  end: Date;
  prevStart: Date;
  prevEnd: Date;
}

// ============================================================
// DATE RANGE HELPERS
// ============================================================

function getDateRangeState(preset: DateRange, customStart?: string, customEnd?: string): DateRangeState {
  const end = new Date();
  end.setHours(23, 59, 59, 999);

  let start = new Date(end);
  let prevEnd = new Date(end);
  let prevStart = new Date(end);

  if (preset === '7d') {
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);
    prevStart.setDate(prevStart.getDate() - 13);
    prevStart.setHours(0, 0, 0, 0);
    prevEnd.setDate(prevEnd.getDate() - 7);
    prevEnd.setHours(23, 59, 59, 999);
  } else if (preset === '30d') {
    start.setDate(start.getDate() - 29);
    start.setHours(0, 0, 0, 0);
    prevStart.setDate(prevStart.getDate() - 59);
    prevStart.setHours(0, 0, 0, 0);
    prevEnd.setDate(prevEnd.getDate() - 30);
    prevEnd.setHours(23, 59, 59, 999);
  } else if (preset === '90d') {
    start.setDate(start.getDate() - 89);
    start.setHours(0, 0, 0, 0);
    prevStart.setDate(prevStart.getDate() - 179);
    prevStart.setHours(0, 0, 0, 0);
    prevEnd.setDate(prevEnd.getDate() - 90);
    prevEnd.setHours(23, 59, 59, 999);
  } else if (preset === 'custom' && customStart && customEnd) {
    start = new Date(customStart);
    start.setHours(0, 0, 0, 0);
    end.setTime(new Date(customEnd).getTime());
    end.setHours(23, 59, 59, 999);
    const diffMs = end.getTime() - start.getTime();
    const diffDays = Math.ceil(diffMs / 86400000);
    prevEnd = new Date(start);
    prevEnd.setTime(start.getTime() - 1);
    prevEnd.setHours(23, 59, 59, 999);
    prevStart = new Date(prevEnd);
    prevStart.setDate(prevStart.getDate() - diffDays);
    prevStart.setHours(0, 0, 0, 0);
  }

  return { preset, start, end, prevStart, prevEnd };
}

function formatDateLabel(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatCurrency(amount: number): string {
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// ============================================================
// SHARED UI
// ============================================================

function SkeletonBlock({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-bg-tertiary ${className}`} />;
}

function ChartCard({
  title,
  insight,
  children,
  rightContent,
}: {
  title: string;
  insight?: string;
  children: React.ReactNode;
  rightContent?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
          {insight && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-text-secondary">
              <Lightbulb size={12} className="shrink-0 text-accent" />
              {insight}
            </p>
          )}
        </div>
        {rightContent}
      </div>
      <div className="mt-5">{children}</div>
    </div>
  );
}

function ChartSkeleton({ height = 200 }: { height?: number }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <SkeletonBlock className="h-5 w-40" />
      <SkeletonBlock className="mt-3 h-4 w-60" />
      <div className="mt-6" style={{ height }}>
        <SkeletonBlock className="h-full w-full" />
      </div>
    </div>
  );
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center py-12 text-center">
      <p className="text-sm text-text-secondary">{message}</p>
    </div>
  );
}

// ============================================================
// DATE RANGE PICKER
// ============================================================

function DateRangePicker({
  range,
  onRangeChange,
  customStart,
  customEnd,
  onCustomStartChange,
  onCustomEndChange,
}: {
  range: DateRange;
  onRangeChange: (r: DateRange) => void;
  customStart: string;
  customEnd: string;
  onCustomStartChange: (v: string) => void;
  onCustomEndChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const labels: Record<DateRange, string> = {
    '7d': 'Last 7 days',
    '30d': 'Last 30 days',
    '90d': 'Last 90 days',
    custom: 'Custom range',
  };

  const todayStr = new Date().toISOString().split('T')[0];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="focus-ring flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:border-accent/40"
      >
        <Calendar size={16} className="text-text-secondary" />
        {labels[range]}
        <ChevronDown size={16} className="text-text-secondary" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 w-64 rounded-xl border border-border bg-bg-secondary p-3 shadow-card-hover dark:shadow-card-hover-dark">
            {(['7d', '30d', '90d'] as DateRange[]).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => {
                  onRangeChange(r);
                  setOpen(false);
                }}
                className={`focus-ring w-full rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  range === r ? 'bg-accent/10 text-accent font-medium' : 'text-text-primary hover:bg-bg-tertiary'
                }`}
              >
                {labels[r]}
              </button>
            ))}
            <div className="my-2 border-t border-border" />
            <div className="px-3 py-1">
              <p className="text-xs font-medium text-text-secondary">Custom range</p>
              <div className="mt-2 grid gap-2">
                <input
                  type="date"
                  max={todayStr}
                  value={customStart}
                  onChange={(e) => onCustomStartChange(e.target.value)}
                  className="focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                />
                <input
                  type="date"
                  max={todayStr}
                  value={customEnd}
                  onChange={(e) => onCustomEndChange(e.target.value)}
                  className="focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (customStart && customEnd) {
                      onRangeChange('custom');
                      setOpen(false);
                    }
                  }}
                  disabled={!customStart || !customEnd}
                  className="focus-ring w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  Apply
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================
// LINE CHART (Call Volume Over Time)
// ============================================================

function LineChart({
  data,
  prevData,
  showCompare,
}: {
  data: { date: string; count: number }[];
  prevData: { date: string; count: number }[];
  showCompare: boolean;
}) {
  const allValues = [...data.map((d) => d.count), ...(showCompare ? prevData.map((d) => d.count) : [])];
  const maxVal = Math.max(...allValues, 1);
  const chartW = 600;
  const chartH = 180;
  const padding = { top: 10, right: 10, bottom: 24, left: 32 };
  const plotW = chartW - padding.left - padding.right;
  const plotH = chartH - padding.top - padding.bottom;

  const xStep = data.length > 1 ? plotW / (data.length - 1) : 0;
  const yScale = (v: number) => padding.top + plotH - (v / maxVal) * plotH;
  const xScale = (i: number) => padding.left + i * xStep;

  const currentPath = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(d.count)}`).join(' ');
  const currentArea = `${currentPath} L ${xScale(data.length - 1)} ${padding.top + plotH} L ${xScale(0)} ${padding.top + plotH} Z`;
  const prevPath = prevData.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(d.count)}`).join(' ');

  // Y axis labels
  const yTicks = [0, Math.round(maxVal * 0.5), maxVal];

  return (
    <div>
      <svg viewBox={`0 0 ${chartW} ${chartH}`} className="w-full" style={{ height: chartH }}>
        <defs>
          <linearGradient id="lineGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(37 99 235)" stopOpacity="0.2" />
            <stop offset="100%" stopColor="rgb(37 99 235)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Grid lines */}
        {yTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={padding.left}
              y1={yScale(tick)}
              x2={chartW - padding.right}
              y2={yScale(tick)}
              stroke="rgb(var(--border-default))"
              strokeWidth="1"
              strokeDasharray="2 4"
            />
            <text x={padding.left - 6} y={yScale(tick) + 3} textAnchor="end" fontSize="10" fill="rgb(var(--text-secondary))">
              {tick}
            </text>
          </g>
        ))}
        {/* Previous period line */}
        {showCompare && prevData.length > 0 && (
          <path d={prevPath} fill="none" stroke="rgb(var(--text-secondary))" strokeWidth="2" strokeDasharray="4 4" opacity="0.5" />
        )}
        {/* Current period area + line */}
        <path d={currentArea} fill="url(#lineGrad)" />
        <path d={currentPath} fill="none" stroke="rgb(37 99 235)" strokeWidth="2.5" />
        {/* Current period dots */}
        {data.map((d, i) => (
          <circle key={i} cx={xScale(i)} cy={yScale(d.count)} r="3" fill="rgb(37 99 235)" className="opacity-0 hover:opacity-100" />
        ))}
        {/* X axis labels (show first, middle, last) */}
        {data.length > 0 && (
          <>
            <text x={xScale(0)} y={chartH - 6} textAnchor="start" fontSize="10" fill="rgb(var(--text-secondary))">
              {formatDateLabel(new Date(data[0].date))}
            </text>
            {data.length > 2 && (
              <text x={xScale(Math.floor(data.length / 2))} y={chartH - 6} textAnchor="middle" fontSize="10" fill="rgb(var(--text-secondary))">
                {formatDateLabel(new Date(data[Math.floor(data.length / 2)].date))}
              </text>
            )}
            <text x={xScale(data.length - 1)} y={chartH - 6} textAnchor="end" fontSize="10" fill="rgb(var(--text-secondary))">
              {formatDateLabel(new Date(data[data.length - 1].date))}
            </text>
          </>
        )}
      </svg>
      {showCompare && (
        <div className="mt-2 flex items-center gap-4 text-xs text-text-secondary">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 rounded bg-accent" />
            Current period
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 rounded border-t-2 border-dashed border-text-secondary" />
            Previous period
          </span>
        </div>
      )}
    </div>
  );
}

// ============================================================
// DONUT CHART (Call Outcomes Breakdown)
// ============================================================

function DonutChart({ data }: { data: { label: string; value: number; color: string }[] }) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const radius = 70;
  const strokeW = 28;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center sm:gap-8">
      <div className="relative shrink-0">
        <svg width="180" height="180" viewBox="0 0 180 180">
          <g transform="translate(90 90) rotate(-90)">
            {total === 0 ? (
              <circle r={radius} fill="none" stroke="rgb(var(--bg-tertiary))" strokeWidth={strokeW} />
            ) : (
              data.map((d, i) => {
                const dash = (d.value / total) * circumference;
                const seg = (
                  <circle
                    key={i}
                    r={radius}
                    fill="none"
                    stroke={d.color}
                    strokeWidth={strokeW}
                    strokeDasharray={`${dash} ${circumference - dash}`}
                    strokeDashoffset={-offset}
                  />
                );
                offset += dash;
                return seg;
              })
            )}
          </g>
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold text-text-primary">{total}</span>
          <span className="text-xs text-text-secondary">total calls</span>
        </div>
      </div>
      <div className="flex-1 grid gap-2">
        {data.map((d, i) => (
          <div key={i} className="flex items-center gap-2.5">
            <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: d.color }} />
            <span className="flex-1 text-sm text-text-primary">{d.label}</span>
            <span className="text-sm font-medium text-text-primary">{d.value}</span>
            <span className="w-10 text-right text-xs text-text-secondary">
              {total > 0 ? `${Math.round((d.value / total) * 100)}%` : '—'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// EMERGENCY RESPONSE CHART (bar chart with spike highlighting)
// ============================================================

function EmergencyChart({ data }: { data: { date: string; count: number }[] }) {
  const maxVal = Math.max(...data.map((d) => d.count), 1);
  const avg = data.reduce((sum, d) => sum + d.count, 0) / (data.length || 1);
  const spikeThreshold = avg * 1.5;

  return (
    <div className="flex items-end gap-1" style={{ height: 160 }}>
      {data.map((d, i) => {
        const heightPercent = (d.count / maxVal) * 100;
        const isSpike = d.count > spikeThreshold && d.count > 0;
        return (
          <div key={d.date} className="group relative flex flex-1 flex-col items-center justify-end" style={{ height: '100%' }}>
            <div className="absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-text-primary px-2 py-1 text-xs font-medium text-bg-primary opacity-0 transition-opacity group-hover:opacity-100">
              {d.count} {d.count === 1 ? 'emergency' : 'emergencies'}
            </div>
            <motion.div
              initial={{ height: 0 }}
              animate={{ height: `${heightPercent}%` }}
              transition={{ duration: 0.4, delay: i * 0.02, ease: [0.16, 1, 0.3, 1] }}
              className={`w-full rounded-t-md ${
                isSpike ? 'bg-danger' : d.count > 0 ? 'bg-danger/60' : 'bg-bg-tertiary'
              }`}
              style={{ minHeight: d.count > 0 ? 3 : 2 }}
            />
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// LEAD FUNNEL
// ============================================================

function LeadFunnel({ stages }: { stages: { label: string; value: number; color: string }[] }) {
  const maxVal = Math.max(...stages.map((s) => s.value), 1);

  return (
    <div className="space-y-3">
      {stages.map((stage, i) => {
        const widthPercent = (stage.value / maxVal) * 100;
        const prevValue = i > 0 ? stages[i - 1].value : 0;
        const conversionRate = i > 0 && prevValue > 0 ? Math.round((stage.value / prevValue) * 100) : null;

        return (
          <div key={stage.label}>
            {conversionRate !== null && (
              <div className="mb-1 flex items-center gap-1.5 pl-2 text-xs text-text-secondary">
                <TrendingUp size={12} className={conversionRate >= 50 ? 'text-success-500' : 'text-warning-500'} />
                <span>
                  {conversionRate}% conversion from {stages[i - 1].label}
                </span>
              </div>
            )}
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <motion.div
                  initial={{ width: 0, opacity: 0.5 }}
                  animate={{ width: `${widthPercent}%`, opacity: 1 }}
                  transition={{ duration: 0.5, delay: i * 0.08, ease: [0.16, 1, 0.3, 1] }}
                  className="flex items-center justify-between rounded-lg px-4 py-3"
                  style={{ backgroundColor: stage.color, minWidth: 80 }}
                >
                  <span className="text-sm font-medium text-white">{stage.label}</span>
                  <span className="text-sm font-bold text-white">{stage.value}</span>
                </motion.div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// REVENUE CHART (monthly bars)
// ============================================================

function RevenueChart({ data }: { data: { month: string; revenue: number }[] }) {
  const maxVal = Math.max(...data.map((d) => d.revenue), 1);

  return (
    <div className="flex items-end gap-2" style={{ height: 180 }}>
      {data.map((d, i) => {
        const heightPercent = (d.revenue / maxVal) * 100;
        return (
          <div key={d.month} className="group relative flex flex-1 flex-col items-center justify-end" style={{ height: '100%' }}>
            <div className="absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-text-primary px-2 py-1 text-xs font-medium text-bg-primary opacity-0 transition-opacity group-hover:opacity-100">
              {formatCurrency(d.revenue)}
            </div>
            <motion.div
              initial={{ height: 0 }}
              animate={{ height: `${heightPercent}%` }}
              transition={{ duration: 0.5, delay: i * 0.05, ease: [0.16, 1, 0.3, 1] }}
              className="w-full rounded-t-md bg-cta"
              style={{ minHeight: d.revenue > 0 ? 4 : 2 }}
            />
            <span className="mt-2 text-xs text-text-secondary">{d.month}</span>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// PEAK CALL TIMES HEATMAP
// ============================================================

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function Heatmap({ data }: { data: { day: number; hour: number; count: number }[] }) {
  const maxCount = Math.max(...data.map((d) => d.count), 1);

  function getColor(count: number): string {
    if (count === 0) return 'rgb(var(--bg-tertiary))';
    const intensity = count / maxCount;
    if (intensity > 0.75) return 'rgb(249 115 22)';
    if (intensity > 0.5) return 'rgb(249 115 22 / 0.7)';
    if (intensity > 0.25) return 'rgb(37 99 235 / 0.6)';
    return 'rgb(37 99 235 / 0.25)';
  }

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[500px]">
        <div className="flex">
          <div className="w-10 shrink-0" />
          {HOURS.map((h) => (
            <div key={h} className="flex-1 text-center text-[9px] text-text-secondary">
              {h % 3 === 0 ? `${h}h` : ''}
            </div>
          ))}
        </div>
        {DAYS.map((day, dayIdx) => (
          <div key={day} className="flex items-center">
            <div className="w-10 shrink-0 text-xs text-text-secondary">{day}</div>
            {HOURS.map((h) => {
              const cell = data.find((d) => d.day === dayIdx && d.hour === h);
              const count = cell?.count ?? 0;
              return (
                <div
                  key={h}
                  className="group relative m-0.5 flex-1"
                  title={`${day} ${h}:00 — ${count} ${count === 1 ? 'call' : 'calls'}`}
                >
                  <div
                    className="h-6 rounded-sm transition-transform hover:scale-110"
                    style={{ backgroundColor: getColor(count) }}
                  />
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function HeatmapMobile({ data }: { data: { day: number; hour: number; count: number }[] }) {
  const dayTotals = DAYS.map((_, dayIdx) => data.filter((d) => d.day === dayIdx).reduce((sum, d) => sum + d.count, 0));
  const maxTotal = Math.max(...dayTotals, 1);

  return (
    <div className="space-y-2">
      {DAYS.map((day, dayIdx) => {
        const total = dayTotals[dayIdx];
        const widthPercent = (total / maxTotal) * 100;
        return (
          <div key={day} className="flex items-center gap-3">
            <span className="w-8 text-xs text-text-secondary">{day}</span>
            <div className="flex-1">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${widthPercent}%` }}
                transition={{ duration: 0.4, delay: dayIdx * 0.05 }}
                className="rounded-md bg-cta"
                style={{ height: 20, minWidth: total > 0 ? 4 : 2 }}
              />
            </div>
            <span className="w-8 text-right text-xs font-medium text-text-primary">{total}</span>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// CSV EXPORT
// ============================================================

function exportCsv(
  calls: Call[],
  jobs: Job[],
  leads: Lead[],
  rangeState: DateRangeState,
  metrics: AnalyticsMetrics
) {
  const rows: string[] = [];
  const dateRange = `${formatDateLabel(rangeState.start)} - ${formatDateLabel(rangeState.end)}`;

  rows.push('Vireek Analytics Report');
  rows.push(`Date Range: ${dateRange}`);
  rows.push(`Generated: ${new Date().toLocaleString()}`);
  rows.push('');
  rows.push('SUMMARY');
  rows.push(`Total Calls,${metrics.totalCalls}`);
  rows.push(`Emergency Calls,${metrics.emergencyCalls}`);
  rows.push(`Total Leads,${metrics.totalLeads}`);
  rows.push(`Leads Won,${metrics.leadsWon}`);
  rows.push(`Conversion Rate,${metrics.conversionRate}%`);
  rows.push(`Revenue,${metrics.revenue}`);
  rows.push('');

  rows.push('CALL OUTCOMES');
  metrics.outcomes.forEach((o) => rows.push(`${o.label},${o.value},${o.percentage}%`));
  rows.push('');

  rows.push('LEAD FUNNEL');
  metrics.funnel.forEach((s) => rows.push(`${s.label},${s.value}`));
  rows.push('');

  rows.push('CALL VOLUME BY DAY');
  rows.push('Date,Calls');
  metrics.callVolume.forEach((d) => rows.push(`${formatDateLabel(new Date(d.date))},${d.count}`));
  rows.push('');

  rows.push('PEAK CALL TIMES (Day x Hour)');
  rows.push('Day,Hour,Count');
  metrics.heatmap.forEach((d) => rows.push(`${DAYS[d.day]},${d.hour}:00,${d.count}`));
  rows.push('');

  rows.push('CALLS');
  rows.push('Date,Caller,Phone,Duration (s),Status,Emergency,Summary');
  calls.forEach((c) => {
    const safeSummary = (c.summary ?? '').replace(/"/g, '""');
    rows.push(`"${new Date(c.call_datetime).toLocaleString()}","${c.caller_name ?? 'Unknown'}","${c.caller_phone ?? ''}",${c.duration_seconds ?? 0},"${c.status}",${c.is_emergency ? 'Yes' : 'No'},"${safeSummary}"`);
  });
  rows.push('');

  rows.push('JOBS');
  rows.push('Customer,Service,Status,Scheduled,Invoice Amount,Invoice Status');
  jobs.forEach((j) => {
    rows.push(`"${j.customer_name}","${j.service_type ?? ''}","${j.job_status}","${j.scheduled_datetime ? new Date(j.scheduled_datetime).toLocaleString() : ''}",${j.invoice_amount ?? 0},"${j.invoice_status}"`);
  });

  const csv = rows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `vireek-analytics-${dateRange.replace(/ /g, '-')}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

// ============================================================
// ANALYTICS METRICS TYPE
// ============================================================

interface AnalyticsMetrics {
  totalCalls: number;
  emergencyCalls: number;
  totalLeads: number;
  leadsWon: number;
  conversionRate: number;
  revenue: number;
  outcomes: { label: string; value: number; color: string; percentage: number }[];
  funnel: { label: string; value: number; color: string }[];
  callVolume: { date: string; count: number }[];
  prevCallVolume: { date: string; count: number }[];
  emergencyVolume: { date: string; count: number }[];
  heatmap: { day: number; hour: number; count: number }[];
  revenueByMonth: { month: string; revenue: number }[];
  insights: Record<string, string>;
}

// ============================================================
// MAIN ANALYTICS PAGE
// ============================================================

export function AnalyticsPage() {
  const navigate = useNavigate();
  const { user, profile, profileLoading, isOwner, permissions } = useAuth();
  const { toast } = useToast();

  const canAccess = isOwner || permissions.can_view_billing;

  useKeyboardShortcut({
    key: '/', handler: () => navigate('/dashboard'), enabled: canAccess,
  });

  const [allCalls, setAllCalls] = useState<Call[]>([]);
  const [allJobs, setAllJobs] = useState<Job[]>([]);
  const [allLeads, setAllLeads] = useState<Lead[]>([]);
  const [dataLoading, setDataLoading] = useState(true);

  const [range, setRange] = useState<DateRange>('30d');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [showCompare, setShowCompare] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const loadData = useCallback(async () => {
    if (!user) return;
    setDataLoading(true);
    try {
      const [callsRes, jobsRes, leadsRes] = await Promise.all([
        supabase.from('calls').select('*').order('call_datetime', { ascending: false }),
        supabase.from('jobs').select('*').order('created_at', { ascending: false }),
        supabase.from('leads').select('*').order('created_at', { ascending: false }),
      ]);
      if (callsRes.data) setAllCalls(callsRes.data as Call[]);
      if (jobsRes.data) setAllJobs(jobsRes.data as Job[]);
      if (leadsRes.data) setAllLeads(leadsRes.data as Lead[]);
    } catch {
      // empty states
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

  const rangeState = useMemo(() => getDateRangeState(range, customStart, customEnd), [range, customStart, customEnd]);

  const metrics = useMemo((): AnalyticsMetrics => {
    const { start, end, prevStart, prevEnd } = rangeState;

    const callsInRange = allCalls.filter((c) => {
      const d = new Date(c.call_datetime);
      return d >= start && d <= end;
    });
    const prevCallsInRange = allCalls.filter((c) => {
      const d = new Date(c.call_datetime);
      return d >= prevStart && d <= prevEnd;
    });
    const jobsInRange = allJobs.filter((j) => {
      const d = new Date(j.created_at);
      return d >= start && d <= end;
    });
    const leadsInRange = allLeads.filter((l) => {
      const d = new Date(l.created_at);
      return d >= start && d <= end;
    });

    // Call volume over time
    const callVolume: { date: string; count: number }[] = [];
    const prevCallVolume: { date: string; count: number }[] = [];
    const numDays = Math.ceil((end.getTime() - start.getTime()) / 86400000) + 1;
    for (let i = 0; i < numDays; i++) {
      const dayStart = new Date(start);
      dayStart.setDate(dayStart.getDate() + i);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);

      const count = callsInRange.filter((c) => {
        const d = new Date(c.call_datetime);
        return d >= dayStart && d < dayEnd;
      }).length;
      callVolume.push({ date: dayStart.toISOString(), count });

      const prevDayStart = new Date(prevStart);
      prevDayStart.setDate(prevDayStart.getDate() + i);
      prevDayStart.setHours(0, 0, 0, 0);
      const prevDayEnd = new Date(prevDayStart);
      prevDayEnd.setDate(prevDayEnd.getDate() + 1);
      const prevCount = prevCallsInRange.filter((c) => {
        const d = new Date(c.call_datetime);
        return d >= prevDayStart && d < prevDayEnd;
      }).length;
      prevCallVolume.push({ date: prevDayStart.toISOString(), count: prevCount });
    }

    // Emergency volume over time
    const emergencyVolume = callVolume.map((d) => {
      const dayStart = new Date(d.date);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);
      const count = callsInRange.filter((c) => {
        const dt = new Date(c.call_datetime);
        return c.is_emergency && dt >= dayStart && dt < dayEnd;
      }).length;
      return { date: d.date, count };
    });

    // Outcomes breakdown
    const outcomeConfig: Record<string, { label: string; color: string }> = {
      new_lead: { label: 'New Lead', color: 'rgb(37 99 235)' },
      booked: { label: 'Booked', color: 'rgb(34 197 94)' },
      missed: { label: 'Missed', color: 'rgb(239 68 68)' },
      callback_requested: { label: 'Callback', color: 'rgb(245 158 11)' },
      spam: { label: 'Spam', color: 'rgb(148 163 184)' },
    };
    const totalCalls = callsInRange.length;
    const outcomes = (Object.keys(outcomeConfig) as Call['status'][]).map((status) => {
      const value = callsInRange.filter((c) => c.status === status).length;
      return {
        label: outcomeConfig[status].label,
        value,
        color: outcomeConfig[status].color,
        percentage: totalCalls > 0 ? Math.round((value / totalCalls) * 100) : 0,
      };
    });

    // Lead funnel
    const funnelStages: { label: string; value: number; color: string }[] = [
      { label: 'New', value: leadsInRange.filter((l) => l.stage === 'new').length, color: 'rgb(37 99 235)' },
      { label: 'Contacted', value: leadsInRange.filter((l) => l.stage === 'contacted' || l.stage === 'quoted' || l.stage === 'won' || l.stage === 'lost').length, color: 'rgb(59 130 246)' },
      { label: 'Quoted', value: leadsInRange.filter((l) => l.stage === 'quoted' || l.stage === 'won' || l.stage === 'lost').length, color: 'rgb(245 158 11)' },
      { label: 'Won', value: leadsInRange.filter((l) => l.stage === 'won').length, color: 'rgb(34 197 94)' },
    ];
    funnelStages.push({ label: 'Lost', value: leadsInRange.filter((l) => l.stage === 'lost').length, color: 'rgb(239 68 68)' });

    // Revenue by month
    const revenueByMonth: { month: string; revenue: number }[] = [];
    const monthMap = new Map<string, number>();
    allJobs
      .filter((j) => j.invoice_status === 'paid' && j.invoice_amount)
      .forEach((j) => {
        const d = new Date(j.created_at);
        const key = `${d.getFullYear()}-${d.getMonth()}`;
        const label = d.toLocaleDateString('en-US', { month: 'short' });
        monthMap.set(key, (monthMap.get(key) ?? 0) + (j.invoice_amount ?? 0));
      });
    // Build last 6 months
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      const label = d.toLocaleDateString('en-US', { month: 'short' });
      revenueByMonth.push({ month: label, revenue: monthMap.get(key) ?? 0 });
    }

    // Heatmap data
    const heatmap: { day: number; hour: number; count: number }[] = [];
    for (let day = 0; day < 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const count = callsInRange.filter((c) => {
          const d = new Date(c.call_datetime);
          return d.getDay() === day && d.getHours() === hour;
        }).length;
        heatmap.push({ day, hour, count });
      }
    }

    // Compute insights
    const insights: Record<string, string> = {};

    // Call volume insight
    const totalCurrent = callVolume.reduce((s, d) => s + d.count, 0);
    const totalPrev = prevCallVolume.reduce((s, d) => s + d.count, 0);
    if (totalPrev > 0) {
      const change = Math.round(((totalCurrent - totalPrev) / totalPrev) * 100);
      insights.callVolume = `${change >= 0 ? 'Up' : 'Down'} ${Math.abs(change)}% vs the previous period (${totalPrev} calls)`;
    } else if (totalCurrent > 0) {
      insights.callVolume = `${totalCurrent} calls in this period`;
    }

    // Outcomes insight
    const booked = outcomes.find((o) => o.label === 'Booked');
    if (booked && totalCalls > 0) {
      insights.outcomes = `${booked.percentage}% of calls resulted in a booking (${booked.value} calls)`;
    }

    // Emergency insight
    const emergencyCalls = callsInRange.filter((c) => c.is_emergency);
    if (emergencyCalls.length > 0) {
      const emergencyByDay: Record<number, number> = {};
      emergencyCalls.forEach((c) => {
        const day = new Date(c.call_datetime).getDay();
        emergencyByDay[day] = (emergencyByDay[day] ?? 0) + 1;
      });
      const peakDay = Object.entries(emergencyByDay).sort((a, b) => b[1] - a[1])[0];
      if (peakDay) {
        insights.emergency = `${DAYS[parseInt(peakDay[0])]}s see the most emergency calls (${peakDay[1]} total)`;
      }
    }

    // Funnel insight
    const newLeads = funnelStages[0].value;
    const wonLeads = funnelStages[3].value;
    if (newLeads > 0) {
      insights.funnel = `${Math.round((wonLeads / newLeads) * 100)}% of new leads convert to won deals`;
    }

    // Revenue insight
    const totalRevenue = revenueByMonth.reduce((s, d) => s + d.revenue, 0);
    if (totalRevenue > 0) {
      const avgMonthly = totalRevenue / revenueByMonth.length;
      insights.revenue = `Averaging ${formatCurrency(avgMonthly)} per month over the last 6 months`;
    }

    // Heatmap insight
    const peakCell = heatmap.sort((a, b) => b.count - a.count)[0];
    if (peakCell && peakCell.count > 0) {
      insights.heatmap = `Peak call time: ${DAYS[peakCell.day]}s at ${peakCell.hour}:00 (${peakCell.count} calls)`;
    }

    return {
      totalCalls,
      emergencyCalls: emergencyCalls.length,
      totalLeads: leadsInRange.length,
      leadsWon: wonLeads,
      conversionRate: newLeads > 0 ? Math.round((wonLeads / newLeads) * 100) : 0,
      revenue: allJobs
        .filter((j) => j.invoice_status === 'paid' && new Date(j.created_at) >= start && new Date(j.created_at) <= end)
        .reduce((sum, j) => sum + (j.invoice_amount ?? 0), 0),
      outcomes,
      funnel: funnelStages,
      callVolume,
      prevCallVolume,
      emergencyVolume,
      heatmap,
      revenueByMonth,
      insights,
    };
  }, [allCalls, allJobs, allLeads, rangeState]);

  const handleExport = () => {
    const callsInRange = allCalls.filter((c) => {
      const d = new Date(c.call_datetime);
      return d >= rangeState.start && d <= rangeState.end;
    });
    const jobsInRange = allJobs.filter((j) => {
      const d = new Date(j.created_at);
      return d >= rangeState.start && d <= rangeState.end;
    });
    const leadsInRange = allLeads.filter((l) => {
      const d = new Date(l.created_at);
      return d >= rangeState.start && d <= rangeState.end;
    });
    exportCsv(callsInRange, jobsInRange, leadsInRange, rangeState, metrics);
    toast('Report exported as CSV.', 'success');
  };

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Analytics">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Analytics access is restricted. Ask your account owner to grant you the "View Billing" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Analytics">
        {/* Page header with date range picker */}
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => navigate('/dashboard')}
              className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
              aria-label="Back to dashboard"
            >
              <ArrowLeft size={18} />
            </button>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Analytics</h1>
              <p className="mt-1 text-sm text-text-secondary">
                {formatDateLabel(rangeState.start)} — {formatDateLabel(rangeState.end)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <DateRangePicker
              range={range}
              onRangeChange={setRange}
              customStart={customStart}
              customEnd={customEnd}
              onCustomStartChange={setCustomStart}
              onCustomEndChange={setCustomEnd}
            />
            <button
              type="button"
              onClick={handleExport}
              disabled={dataLoading}
              className="focus-ring flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:border-accent/40 disabled:opacity-50"
            >
              <Download size={16} className="text-text-secondary" />
              <span className="hidden sm:inline">Export Report</span>
            </button>
          </div>
        </div>

        {/* Summary KPIs */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {dataLoading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
                <SkeletonBlock className="h-4 w-24" />
                <SkeletonBlock className="mt-3 h-8 w-16" />
              </div>
            ))
          ) : (
            <>
              <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
                <p className="text-xs font-medium text-text-secondary">Total Calls</p>
                <p className="mt-2 text-3xl font-bold text-text-primary">{metrics.totalCalls}</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
                <p className="text-xs font-medium text-text-secondary">Emergency Calls</p>
                <p className="mt-2 text-3xl font-bold text-danger">{metrics.emergencyCalls}</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
                <p className="text-xs font-medium text-text-secondary">Conversion Rate</p>
                <p className="mt-2 text-3xl font-bold text-text-primary">{metrics.conversionRate}%</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
                <p className="text-xs font-medium text-text-secondary">Revenue</p>
                <p className="mt-2 text-3xl font-bold text-cta">{formatCurrency(metrics.revenue)}</p>
              </div>
            </>
          )}
        </div>

        {/* Call Volume Over Time */}
        <div className="mt-6">
          {dataLoading ? (
            <ChartSkeleton />
          ) : (
            <ChartCard
              title="Call Volume Over Time"
              insight={metrics.insights.callVolume}
              rightContent={
                <label className="flex cursor-pointer items-center gap-2 text-xs text-text-secondary">
                  <input
                    type="checkbox"
                    checked={showCompare}
                    onChange={(e) => setShowCompare(e.target.checked)}
                    className="accent-accent"
                  />
                  Compare to previous period
                </label>
              }
            >
              {metrics.callVolume.length === 0 || metrics.callVolume.every((d) => d.count === 0) ? (
                <EmptyChart message="No calls in this period." />
              ) : (
                <LineChart
                  data={metrics.callVolume}
                  prevData={metrics.prevCallVolume}
                  showCompare={showCompare}
                />
              )}
            </ChartCard>
          )}
        </div>

        {/* Call Outcomes + Emergency Response */}
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          {dataLoading ? (
            <>
              <ChartSkeleton />
              <ChartSkeleton />
            </>
          ) : (
            <>
              <ChartCard title="Call Outcomes Breakdown" insight={metrics.insights.outcomes}>
                {metrics.totalCalls === 0 ? (
                  <EmptyChart message="No calls to analyze." />
                ) : (
                  <DonutChart data={metrics.outcomes} />
                )}
              </ChartCard>

              <ChartCard title="Emergency Response" insight={metrics.insights.emergency}>
                {metrics.emergencyVolume.every((d) => d.count === 0) ? (
                  <EmptyChart message="No emergency calls in this period." />
                ) : (
                  <>
                    <EmergencyChart data={metrics.emergencyVolume} />
                    <div className="mt-3 flex items-center justify-between">
                      <span className="text-xs text-text-secondary">
                        {formatDateLabel(new Date(metrics.emergencyVolume[0].date))}
                      </span>
                      <span className="text-xs text-text-secondary">
                        {formatDateLabel(new Date(metrics.emergencyVolume[metrics.emergencyVolume.length - 1].date))}
                      </span>
                    </div>
                  </>
                )}
              </ChartCard>
            </>
          )}
        </div>

        {/* Lead Funnel + Revenue */}
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          {dataLoading ? (
            <>
              <ChartSkeleton />
              <ChartSkeleton />
            </>
          ) : (
            <>
              <ChartCard title="Lead Funnel" insight={metrics.insights.funnel}>
                {metrics.totalLeads === 0 ? (
                  <EmptyChart message="No leads in this period." />
                ) : (
                  <LeadFunnel stages={metrics.funnel} />
                )}
              </ChartCard>

              <ChartCard title="Revenue Trend" insight={metrics.insights.revenue}>
                {metrics.revenueByMonth.every((d) => d.revenue === 0) ? (
                  <EmptyChart message="No revenue data yet." />
                ) : (
                  <RevenueChart data={metrics.revenueByMonth} />
                )}
              </ChartCard>
            </>
          )}
        </div>

        {/* Peak Call Times Heatmap */}
        <div className="mt-6">
          {dataLoading ? (
            <ChartSkeleton height={250} />
          ) : (
            <ChartCard title="Peak Call Times" insight={metrics.insights.heatmap}>
              {metrics.totalCalls === 0 ? (
                <EmptyChart message="No call data to build a heatmap." />
              ) : isMobile ? (
                <HeatmapMobile data={metrics.heatmap} />
              ) : (
                <Heatmap data={metrics.heatmap} />
              )}
            </ChartCard>
          )}
        </div>
    </DashboardLayout>
  );
}
