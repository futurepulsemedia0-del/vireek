import {
  BUCKET_LABELS,
  BUCKET_ORDER,
  BUCKET_STYLES,
  bucketCounts,
  pointLabel,
  pointMatrix,
  rankBucket,
  type GeoGridPoint,
  type RankBucket,
} from '@/lib/geoGrid';

interface GridMapProps {
  points: readonly GeoGridPoint[];
  size: number;
  selectedId: string | null;
  onSelect: (point: GeoGridPoint) => void;
}

function cellText(p: GeoGridPoint): string {
  if (p.outcome === 'error') return '!';
  if (p.outcome === 'ranked' && p.rank !== null) return String(p.rank);
  return '20+';
}

/** The grid itself: north is up, the business sits in the centre cell. Fully keyboard and screen-reader accessible. */
export function GridMap({ points, size, selectedId, onSelect }: GridMapProps) {
  const matrix = pointMatrix(points, size);
  const mid = (size - 1) / 2;
  const text = size >= 9 ? 'text-[11px] sm:text-xs' : size >= 7 ? 'text-xs sm:text-sm' : 'text-sm sm:text-base';

  return (
    <div
      role="group"
      aria-label={`Local rank grid, ${size} by ${size}. North is at the top.`}
      className="mx-auto grid w-full max-w-[560px] gap-1 sm:gap-1.5"
      style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))` }}
    >
      {matrix.flatMap((row, r) =>
        row.map((p, c) => {
          const isCenter = r === mid && c === mid;
          if (!p) {
            return <div key={`${r}-${c}`} aria-hidden="true" className="aspect-square rounded-full border border-dashed border-border" />;
          }
          const bucket = rankBucket(p.outcome, p.rank);
          const selected = p.id === selectedId;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelect(p)}
              aria-pressed={selected}
              aria-label={`Row ${r + 1}, column ${c + 1}${isCenter ? ' (your business)' : ''}: ${pointLabel(p)}`}
              className={`focus-ring relative flex aspect-square min-h-[32px] items-center justify-center rounded-full border font-bold transition-transform active:scale-95 ${text} ${BUCKET_STYLES[bucket]} ${
                selected ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg-primary' : ''
              } ${isCenter && !selected ? 'ring-2 ring-text-primary/60 ring-offset-1 ring-offset-bg-primary' : ''}`}
            >
              {cellText(p)}
            </button>
          );
        }),
      )}
    </div>
  );
}

export function GridLegend({ points }: { points: readonly GeoGridPoint[] }) {
  const counts = bucketCounts(points);
  const buckets = BUCKET_ORDER.filter((b: RankBucket) => counts[b] > 0 || b !== 'error');
  return (
    <ul aria-label="Legend" className="flex flex-wrap justify-center gap-x-4 gap-y-2 text-xs text-text-secondary">
      {buckets.map((b) => (
        <li key={b} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={`inline-block h-3.5 w-3.5 rounded-full border ${BUCKET_STYLES[b]}`} />
          {BUCKET_LABELS[b]} <span className="font-semibold text-text-primary">{counts[b]}</span>
        </li>
      ))}
    </ul>
  );
}

/** Share-of-local-voice over time (oldest → newest). Heights are percentages, so it needs no chart library. */
export function TrendBars({ series }: { series: { id: string; at: string; solv: number }[] }) {
  if (series.length < 2) return null;
  return (
    <div>
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-text-secondary">Share of local voice over time</p>
      <ul className="flex h-20 items-end gap-1" aria-label="Share of local voice per scan, oldest to newest">
        {series.map((s) => (
          <li key={s.id} className="flex h-full min-w-0 flex-1 items-end" title={`${new Date(s.at).toLocaleDateString()}: ${s.solv}%`}>
            <span
              className="block w-full rounded-t bg-accent/70"
              style={{ height: `${Math.max(4, Math.min(100, s.solv))}%` }}
              role="img"
              aria-label={`${new Date(s.at).toLocaleDateString()}: ${s.solv} percent`}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
