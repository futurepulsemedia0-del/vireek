import { useId, useMemo } from 'react';
import { fmtNum, monthLabel } from '@/lib/energyIntelligence';
import type { ForecastScenario, FuelSummary } from '@/lib/energyIntelligence';

const W = 640;
const H = 220;
const PAD = { l: 44, r: 12, t: 12, b: 26 };

function scale(max: number) {
  const m = Math.max(max, 1);
  const pow = 10 ** Math.floor(Math.log10(m));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * pow).find((s) => m / s <= 4) ?? 10 * pow;
  const top = Math.ceil(m / step) * step;
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) };
}

/** Billed usage (bars) vs what the weather model expects (line), last 12 months. */
export function UsageChart({ fuel }: { fuel: FuelSummary }) {
  const titleId = useId();
  const { bars, line, top, ticks } = useMemo(() => {
    const max = Math.max(...fuel.months.map((m) => Math.max(m.actual ?? 0, m.modeled ?? 0)), 1);
    const s = scale(max);
    const bw = (W - PAD.l - PAD.r) / fuel.months.length;
    const y = (v: number) => PAD.t + (1 - v / s.top) * (H - PAD.t - PAD.b);
    const bars = fuel.months.map((m, i) => ({
      x: PAD.l + i * bw + bw * 0.18,
      w: bw * 0.64,
      y: m.actual === null ? null : y(m.actual),
      key: m.key,
      v: m.actual,
    }));
    const pts = fuel.months
      .map((m, i) => (m.modeled === null ? null : `${PAD.l + i * bw + bw / 2},${y(m.modeled)}`))
      .filter(Boolean);
    return { bars, line: pts.join(' '), top: s.top, ticks: s.ticks.map((t) => ({ t, y: y(t) })) };
  }, [fuel]);
  const base = H - PAD.b;
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={titleId} className="w-full">
        <title id={titleId}>
          {fuel.fuel === 'electric' ? 'Electric' : 'Gas'} usage by month ({fuel.unit}), billed
          versus weather model
        </title>
        {ticks.map((t) => (
          <g key={t.t}>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={t.y}
              y2={t.y}
              className="stroke-border"
              strokeWidth={1}
            />
            <text
              x={PAD.l - 6}
              y={t.y + 3}
              textAnchor="end"
              className="fill-text-secondary text-[10px]"
            >
              {fmtNum(t.t)}
            </text>
          </g>
        ))}
        {bars.map((b) =>
          b.y === null ? null : (
            <rect
              key={b.key}
              x={b.x}
              y={b.y}
              width={b.w}
              height={Math.max(0, base - b.y)}
              rx={3}
              className="fill-accent/70"
            >
              <title>{`${b.key}: ${fmtNum(b.v)} ${fuel.unit}`}</title>
            </rect>
          ),
        )}
        {line && (
          <polyline
            points={line}
            fill="none"
            strokeWidth={2}
            strokeDasharray="5 3"
            className="stroke-warning-500"
          />
        )}
        {fuel.months.map((m, i) => (
          <text
            key={m.key}
            x={PAD.l + (i + 0.5) * ((W - PAD.l - PAD.r) / fuel.months.length)}
            y={H - 8}
            textAnchor="middle"
            className="fill-text-secondary text-[10px]"
          >
            {monthLabel(m.key)}
          </text>
        ))}
        <text
          x={PAD.l}
          y={8}
          className="fill-text-secondary text-[10px]"
        >{`max ${fmtNum(top)} ${fuel.unit}`}</text>
      </svg>
      <figcaption className="mt-1 flex flex-wrap items-center gap-4 text-[11px] text-text-secondary">
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-3 rounded-sm bg-accent/70" aria-hidden="true" /> Billed
        </span>
        <span className="inline-flex items-center gap-1">
          <span
            className="h-0 w-4 border-t-2 border-dashed border-warning-500"
            aria-hidden="true"
          />{' '}
          Weather model
        </span>
      </figcaption>
    </figure>
  );
}

const SCENARIO_STROKE: Record<ForecastScenario['key'], string> = {
  baseline: 'stroke-accent',
  hot_summer: 'stroke-danger-500',
  cold_winter: 'stroke-warning-500',
  upgraded: 'stroke-success-500',
};

/** Next-12-month electric demand by scenario, with the 80% band around the baseline. */
export function ForecastChart({ scenarios }: { scenarios: ForecastScenario[] }) {
  const titleId = useId();
  const geo = useMemo(() => {
    const base = scenarios.find((s) => s.key === 'baseline') ?? scenarios[0];
    if (!base) return null;
    const max = Math.max(
      ...scenarios.flatMap((s) => s.months.map((m) => m.kwh)),
      ...base.months.map((m) => m.kwh_high),
      1,
    );
    const s = scale(max);
    const step = (W - PAD.l - PAD.r) / Math.max(1, base.months.length - 1);
    const x = (i: number) => PAD.l + i * step;
    const y = (v: number) => PAD.t + (1 - v / s.top) * (H - PAD.t - PAD.b);
    const band = [
      ...base.months.map((m, i) => `${x(i)},${y(m.kwh_high)}`),
      ...[...base.months]
        .reverse()
        .map((m, i) => `${x(base.months.length - 1 - i)},${y(m.kwh_low)}`),
    ].join(' ');
    return {
      base,
      band,
      ticks: s.ticks.map((t) => ({ t, y: y(t) })),
      lines: scenarios.map((sc) => ({
        key: sc.key,
        label: sc.label,
        pts: sc.months.map((m, i) => `${x(i)},${y(m.kwh)}`).join(' '),
      })),
      x,
    };
  }, [scenarios]);
  if (!geo) return null;
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={titleId} className="w-full">
        <title id={titleId}>
          Forecast electric demand in kWh for the next 12 months by scenario
        </title>
        {geo.ticks.map((t) => (
          <g key={t.t}>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={t.y}
              y2={t.y}
              className="stroke-border"
              strokeWidth={1}
            />
            <text
              x={PAD.l - 6}
              y={t.y + 3}
              textAnchor="end"
              className="fill-text-secondary text-[10px]"
            >
              {fmtNum(t.t)}
            </text>
          </g>
        ))}
        <polygon points={geo.band} className="fill-accent/10" />
        {geo.lines.map((l) => (
          <polyline
            key={l.key}
            points={l.pts}
            fill="none"
            strokeWidth={l.key === 'baseline' ? 2.5 : 1.75}
            strokeDasharray={l.key === 'baseline' ? undefined : '5 3'}
            className={SCENARIO_STROKE[l.key]}
          />
        ))}
        {geo.base.months.map((m, i) => (
          <text
            key={m.month}
            x={geo.x(i)}
            y={H - 8}
            textAnchor="middle"
            className="fill-text-secondary text-[10px]"
          >
            {monthLabel(m.month)}
          </text>
        ))}
      </svg>
      <figcaption className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-text-secondary">
        {geo.lines.map((l) => (
          <span key={l.key} className="inline-flex items-center gap-1">
            <svg width="16" height="6" aria-hidden="true">
              <line
                x1="0"
                x2="16"
                y1="3"
                y2="3"
                strokeWidth="2"
                className={SCENARIO_STROKE[l.key]}
              />
            </svg>
            {l.label}
          </span>
        ))}
        <span>Shaded: 80% range, normal weather</span>
      </figcaption>
    </figure>
  );
}
