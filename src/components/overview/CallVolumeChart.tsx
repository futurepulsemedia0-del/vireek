import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Panel } from '@/components/ui/Panel';
import { countTicks } from '@/lib/chartScale';
import { formatDate, formatNumber } from '@/lib/format';

export interface CallVolumePoint {
  /** ISO date of the bucket start. */
  date: string;
  count: number;
}

export interface ChartEvent {
  /** ISO date; marks the bucket that contains it. */
  date: string;
  label: string;
}

interface CallVolumeChartProps {
  data: readonly CallVolumePoint[];
  /** 1 = daily buckets, 7 = weekly buckets. */
  bucketDays?: number;
  /** Optional annotations (campaign launch, storm). Rendered only when provided; never invented. */
  events?: readonly ChartEvent[];
  title?: string;
}

const W = 720;
const H = 220;
const PAD = { top: 16, right: 12, bottom: 28, left: 36 };

/**
 * Honest count chart: zero baseline, labelled y axis with gridlines, x labels,
 * exact values on hover/focus, direct label on the peak, and a table fallback.
 * No entrance animation, no gradient, no smoothing.
 */
export function CallVolumeChart({ data, bucketDays = 1, events = [], title }: CallVolumeChartProps) {
  const { t } = useTranslation('dashboard');
  const tableId = useId();
  const [active, setActive] = useState<number | null>(null);

  const total = data.reduce((s, d) => s + d.count, 0);
  const max = Math.max(...data.map((d) => d.count), 0);
  const ticks = countTicks(max);
  const top = ticks[ticks.length - 1];
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = data.length > 0 ? innerW / data.length : innerW;
  const barW = Math.max(2, Math.min(28, slot * 0.64));
  const y = (v: number) => PAD.top + innerH - (v / top) * innerH;
  const x = (i: number) => PAD.left + slot * i + (slot - barW) / 2;
  const peakIndex = max > 0 ? data.findIndex((d) => d.count === max) : -1;

  const label = (iso: string) => formatDate(iso, { month: 'short', day: 'numeric' });
  const rangeLabel = (i: number) => {
    const d = data[i];
    if (!d) return '';
    if (bucketDays <= 1) return label(d.date);
    const end = new Date(new Date(d.date).getTime() + (bucketDays - 1) * 86_400_000);
    return `${label(d.date)} – ${label(end.toISOString())}`;
  };

  // x labels: first, middle, last (no crowding).
  const xLabelIdx = data.length <= 1 ? [0] : Array.from(new Set([0, Math.floor((data.length - 1) / 2), data.length - 1]));

  const eventIdx = events
    .map((e) => {
      const ts = new Date(e.date).getTime();
      const i = data.findIndex((d, k) => {
        const s = new Date(d.date).getTime();
        const next = k + 1 < data.length ? new Date(data[k + 1].date).getTime() : s + bucketDays * 86_400_000;
        return ts >= s && ts < next;
      });
      return i >= 0 ? { i, label: e.label } : null;
    })
    .filter((e): e is { i: number; label: string } => e !== null);

  const heading =
    (title ?? t('overview.callVolume.title', 'Call volume')) +
    (bucketDays > 1 ? ` · ${t('overview.callVolume.weekly', 'weekly')}` : '');

  return (
    <Panel
      title={heading}
      actions={<span className="tabular-nums">{t('overview.callVolume.total', { count: total, defaultValue_one: '{{count}} call', defaultValue_other: '{{count}} calls' })}</span>}
    >
      {data.length === 0 || max === 0 ? (
        <p className="py-3 text-[13px] text-text-secondary">{t('overview.callVolume.empty', 'No calls in this period.')}</p>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={t('overview.callVolume.aria', 'Calls per {{unit}}, {{total}} in total. A data table follows.', {
              unit: bucketDays > 1 ? t('overview.callVolume.week', 'week') : t('overview.callVolume.day', 'day'),
              total,
            })}
            className="block w-full text-text-secondary"
            onMouseLeave={() => setActive(null)}
          >
            {ticks.map((v) => (
              <g key={v}>
                <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="currentColor" strokeOpacity={v === 0 ? 0.5 : 0.15} strokeWidth={1} />
                <text x={PAD.left - 8} y={y(v)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="currentColor" className="tabular-nums">
                  {formatNumber(v)}
                </text>
              </g>
            ))}

            {data.map((d, i) => (
              <g key={d.date}>
                <rect x={x(i) - (slot - barW) / 2} y={PAD.top} width={slot} height={innerH} fill="transparent" onMouseEnter={() => setActive(i)} />
                {d.count > 0 && (
                  <rect
                    x={x(i)}
                    y={y(d.count)}
                    width={barW}
                    height={y(0) - y(d.count)}
                    rx={2}
                    className={active === i ? 'text-accent-hover' : 'text-accent'}
                    fill="currentColor"
                  >
                    <title>{`${rangeLabel(i)}: ${formatNumber(d.count)}`}</title>
                  </rect>
                )}
              </g>
            ))}

            {eventIdx.map((e) => (
              <g key={`${e.i}-${e.label}`} className="text-text-primary">
                <line x1={x(e.i) + barW / 2} x2={x(e.i) + barW / 2} y1={PAD.top} y2={y(0)} stroke="currentColor" strokeDasharray="3 3" strokeOpacity={0.5} />
                <text x={x(e.i) + barW / 2 + 4} y={PAD.top + 9} fontSize={10} fill="currentColor">{e.label}</text>
              </g>
            ))}

            {peakIndex >= 0 && (
              <text x={x(peakIndex) + barW / 2} y={y(max) - 5} textAnchor="middle" fontSize={11} fontWeight={500} fill="currentColor" className="tabular-nums text-text-primary">
                {formatNumber(max)}
              </text>
            )}

            {xLabelIdx.map((i) => (
              <text key={i} x={x(i) + barW / 2} y={H - 8} textAnchor={i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'} fontSize={11} fill="currentColor">
                {label(data[i].date)}
              </text>
            ))}
          </svg>

          <p className="mt-1 min-h-4 text-xs text-text-secondary tabular-nums" aria-live="polite">
            {active !== null && data[active]
              ? t('overview.callVolume.detail', '{{when}}: {{count}} calls', { when: rangeLabel(active), count: data[active].count })
              : ''}
          </p>

          <details className="mt-2 text-xs text-text-secondary">
            <summary className="focus-ring cursor-pointer rounded text-text-secondary hover:text-text-primary">
              {t('overview.callVolume.viewTable', 'View as table')}
            </summary>
            <table id={tableId} className="mt-2 w-full text-left tabular-nums">
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className="py-1 pr-4 font-medium">{t('overview.callVolume.period', 'Period')}</th>
                  <th scope="col" className="py-1 text-right font-medium">{t('overview.callVolume.calls', 'Calls')}</th>
                </tr>
              </thead>
              <tbody>
                {data.map((d, i) => (
                  <tr key={d.date} className="border-b border-border last:border-0">
                    <td className="py-1 pr-4">{rangeLabel(i)}</td>
                    <td className="py-1 text-right text-text-primary">{formatNumber(d.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </Panel>
  );
}
