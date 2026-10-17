import { useMemo } from 'react';
import { buildBars, formatBucket, formatCount, type UsagePoint } from '@/lib/apiUsage';

const W = 600;
const H = 150;

/** Dependency-free stacked bars: successful / errors / rate-limited. Native <title> tooltips, screen-reader summary. */
export function UsageChart({ points, hours }: { points: UsagePoint[]; hours: number }) {
  const { bars, max } = useMemo(() => buildBars(points, W, H), [points]);
  const total = points.reduce((s, p) => s + p.requests, 0);
  const labelIdx = points.length > 2 ? [0, Math.floor((points.length - 1) / 2), points.length - 1] : points.map((_, i) => i);

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H + 4}`}
        preserveAspectRatio="none"
        className="h-40 w-full"
        role="img"
        aria-label={`Requests over the last ${hours} hours: ${formatCount(total)} total, peak ${formatCount(max)} per interval.`}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={W} y1={H - H * f} y2={H - H * f} stroke="currentColor" strokeOpacity={0.08} />
        ))}
        {bars.map((b, i) => {
          const p = points[i];
          const okY = H - b.okH;
          const errY = okY - b.errH;
          const rlY = errY - b.rlH;
          return (
            <g key={p.bucket}>
              <title>{`${formatBucket(p.bucket, hours)} — ${p.requests} requests, ${p.errors} errors, ${p.rate_limited} rate limited`}</title>
              <rect x={b.x} y={0} width={b.width} height={H} fill="transparent" />
              {b.okH > 0 && <rect x={b.x} y={okY} width={b.width} height={b.okH} rx={1} className="fill-accent" fillOpacity={0.85} />}
              {b.errH > 0 && <rect x={b.x} y={errY} width={b.width} height={b.errH} className="fill-danger" />}
              {b.rlH > 0 && <rect x={b.x} y={rlY} width={b.width} height={b.rlH} className="fill-warning-500" />}
              {p.requests > 0 && b.okH + b.errH + b.rlH < 1.5 && <rect x={b.x} y={H - 1.5} width={b.width} height={1.5} className="fill-accent" />}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-text-secondary" aria-hidden>
        {labelIdx.map((i) => (
          <span key={points[i].bucket}>{formatBucket(points[i].bucket, hours)}</span>
        ))}
      </div>
      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-secondary">
        <span className="flex items-center gap-1.5"><i className="inline-block h-2 w-2 rounded-sm bg-accent" /> Successful</span>
        <span className="flex items-center gap-1.5"><i className="inline-block h-2 w-2 rounded-sm bg-danger" /> Errors</span>
        <span className="flex items-center gap-1.5"><i className="inline-block h-2 w-2 rounded-sm bg-warning-500" /> Rate limited</span>
      </figcaption>
    </figure>
  );
}
