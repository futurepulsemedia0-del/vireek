import { useMemo } from 'react';
import type { ChartType, GroupResult } from '@/lib/reportBuilder';

// ============================================================
// Dependency-free report charts (bar / line / donut).
//
// - Bars are plain HTML (width %) so long labels wrap on phones and
//   text stays selectable/accessible.
// - Line + donut are viewBox-scaled SVG: they shrink to any width.
// - Colours come from the app's CSS variables, so light/dark themes
//   and any future re-brand apply automatically.
// - The grouped table rendered under every chart is the accessible
//   data source; charts are labelled for assistive tech via aria-label.
// ============================================================

interface ReportChartProps {
  type: Exclude<ChartType, 'none'>;
  groups: GroupResult[];
  formatValue: (value: number) => string;
  title: string;
}

const PALETTE = [
  'rgb(var(--accent-primary))',
  'rgb(var(--accent-secondary))',
  'rgb(var(--success))',
  'rgb(var(--warning))',
  'rgb(var(--danger))',
  'rgb(var(--accent-primary) / 0.55)',
  'rgb(var(--accent-secondary) / 0.55)',
  'rgb(var(--success) / 0.55)',
];

const num = (g: GroupResult) => Math.max(0, g.value ?? 0);

function BarChart({ groups, formatValue, title }: Omit<ReportChartProps, 'type'>) {
  const max = Math.max(...groups.map(num), 0);
  return (
    <ul className="space-y-2.5" aria-label={title}>
      {groups.map((g) => {
        const pct = max > 0 ? (num(g) / max) * 100 : 0;
        return (
          <li key={g.key} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-sm sm:grid-cols-[minmax(0,12rem)_1fr_auto]">
            <span className="truncate text-text-secondary" title={g.label}>
              {g.label}
            </span>
            <span className="h-3 overflow-hidden rounded-full bg-bg-tertiary" aria-hidden="true">
              <span
                className="block h-full rounded-full transition-[width] duration-500 ease-out"
                style={{ width: `${Math.max(pct, num(g) > 0 ? 2 : 0)}%`, background: PALETTE[0] }}
              />
            </span>
            <span className="min-w-[3.5rem] text-right font-semibold tabular-nums text-text-primary">
              {g.value === null ? '—' : formatValue(g.value)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const W = 640;
const H = 240;
const pad = { l: 12, r: 12, t: 16, b: 34 };

function LineChart({ groups, formatValue, title }: Omit<ReportChartProps, 'type'>) {
  const geometry = useMemo(() => {
    const values = groups.map(num);
    const max = Math.max(...values, 0) || 1;
    const innerW = W - pad.l - pad.r;
    const innerH = H - pad.t - pad.b;
    const step = groups.length > 1 ? innerW / (groups.length - 1) : 0;
    const points = values.map((v, i) => ({
      x: groups.length > 1 ? pad.l + i * step : pad.l + innerW / 2,
      y: pad.t + innerH - (v / max) * innerH,
    }));
    return { max, points, innerH };
  }, [groups]);

  const path = geometry.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = geometry.points.length > 1 ? `${path} L${geometry.points[geometry.points.length - 1].x.toFixed(1)},${pad.t + geometry.innerH} L${geometry.points[0].x.toFixed(1)},${pad.t + geometry.innerH} Z` : '';
  const labelEvery = Math.max(1, Math.ceil(groups.length / 6));

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={title}>
        {[0, 0.5, 1].map((t) => {
          const y = pad.t + geometry.innerH - t * geometry.innerH;
          return <line key={t} x1={pad.l} x2={W - pad.r} y1={y} y2={y} style={{ stroke: 'rgb(var(--border-default))' }} strokeDasharray="3 4" />;
        })}
        {area && <path d={area} style={{ fill: 'rgb(var(--accent-primary) / 0.12)' }} />}
        <path d={path} fill="none" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" style={{ stroke: PALETTE[0] }} />
        {geometry.points.map((p, i) => (
          <circle key={groups[i].key} cx={p.x} cy={p.y} r={3.5} style={{ fill: PALETTE[0] }}>
            <title>{`${groups[i].label}: ${groups[i].value === null ? '—' : formatValue(groups[i].value as number)}`}</title>
          </circle>
        ))}
        {groups.map((g, i) =>
          i % labelEvery === 0 ? (
            <text key={g.key} x={geometry.points[i].x} y={H - 10} textAnchor="middle" fontSize="11" style={{ fill: 'rgb(var(--text-secondary))' }}>
              {g.label.length > 14 ? `${g.label.slice(0, 13)}…` : g.label}
            </text>
          ) : null,
        )}
      </svg>
      <p className="mt-1 text-right text-xs text-text-secondary">Peak: {formatValue(geometry.max)}</p>
    </div>
  );
}

function DonutChart({ groups, formatValue, title }: Omit<ReportChartProps, 'type'>) {
  const slices = useMemo(() => {
    const positive = groups.filter((g) => num(g) > 0);
    const top = positive.slice(0, 7);
    const rest = positive.slice(7);
    const otherTotal = rest.reduce((s, g) => s + num(g), 0);
    const list = top.map((g) => ({ key: g.key, label: g.label, value: num(g) }));
    if (otherTotal > 0) list.push({ key: '__other__', label: `Other (${rest.length})`, value: otherTotal });
    const total = list.reduce((s, x) => s + x.value, 0);
    return { list, total };
  }, [groups]);

  if (slices.total <= 0) {
    return <p className="py-6 text-center text-sm text-text-secondary">Nothing to chart — every group is zero.</p>;
  }

  const R = 70;
  const C = 2 * Math.PI * R;
  let offset = 0;

  return (
    <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center sm:justify-center">
      <svg viewBox="0 0 180 180" className="h-44 w-44 shrink-0 -rotate-90" role="img" aria-label={title}>
        {slices.list.map((s, i) => {
          const len = (s.value / slices.total) * C;
          const el = (
            <circle
              key={s.key}
              cx={90}
              cy={90}
              r={R}
              fill="none"
              strokeWidth={26}
              strokeDasharray={`${Math.max(len - 1.5, 0)} ${C}`}
              strokeDashoffset={-offset}
              style={{ stroke: PALETTE[i % PALETTE.length] }}
            >
              <title>{`${s.label}: ${formatValue(s.value)}`}</title>
            </circle>
          );
          offset += len;
          return el;
        })}
      </svg>
      <ul className="w-full max-w-xs space-y-1.5 text-sm">
        {slices.list.map((s, i) => (
          <li key={s.key} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: PALETTE[i % PALETTE.length] }} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-text-secondary" title={s.label}>
              {s.label}
            </span>
            <span className="font-semibold tabular-nums text-text-primary">{Math.round((s.value / slices.total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ReportChart({ type, ...rest }: ReportChartProps) {
  if (rest.groups.length === 0) return null;
  if (type === 'line') return <LineChart {...rest} />;
  if (type === 'donut') return <DonutChart {...rest} />;
  return <BarChart {...rest} />;
}
