import { useId, useMemo, useState } from 'react';
import type { SurveyType, TrendPoint } from '@/lib/surveys';

const W = 640;
const H = 220;
const PAD = { top: 16, right: 16, bottom: 28, left: 40 };

/**
 * Daily score trend (NPS: -100..100, CSAT: 0..100). Days without responses are real gaps in the line —
 * we never interpolate across them. Keyboard/touch: points are focusable and a hidden table mirrors the data.
 */
export function SurveyTrendChart({ points, type }: { points: TrendPoint[]; type: SurveyType }) {
  const uid = useId();
  const [active, setActive] = useState<number | null>(null);
  const yMin = type === 'nps' ? -100 : 0;
  const yMax = 100;

  const geo = useMemo(() => {
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const x = (i: number) => PAD.left + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
    const y = (v: number) => PAD.top + (1 - (v - yMin) / (yMax - yMin)) * innerH;
    // Split into contiguous runs so gaps stay gaps.
    const runs: { i: number; v: number }[][] = [];
    let cur: { i: number; v: number }[] = [];
    points.forEach((p, i) => {
      if (p.value === null) {
        if (cur.length) runs.push(cur);
        cur = [];
      } else cur.push({ i, v: p.value });
    });
    if (cur.length) runs.push(cur);
    return { x, y, runs };
  }, [points, yMin]);

  const gridValues = type === 'nps' ? [-100, -50, 0, 50, 100] : [0, 25, 50, 75, 100];
  const labelEvery = Math.max(1, Math.ceil(points.length / 6));
  const hasData = points.some((p) => p.value !== null);
  const activePoint = active !== null ? points[active] : null;

  return (
    <figure className="m-0">
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full"
          role="img"
          aria-labelledby={`${uid}-t`}
          onMouseLeave={() => setActive(null)}
        >
          <title id={`${uid}-t`}>
            {type === 'nps' ? 'Net Promoter Score' : 'Customer satisfaction'} by day over the last {points.length} days
          </title>
          {gridValues.map((g) => (
            <g key={g}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={geo.y(g)}
                y2={geo.y(g)}
                stroke="rgb(var(--border-default))"
                strokeDasharray={g === 0 && type === 'nps' ? '0' : '3 4'}
              />
              <text x={PAD.left - 8} y={geo.y(g) + 4} textAnchor="end" fontSize="11" fill="currentColor" className="text-text-secondary">
                {g}
              </text>
            </g>
          ))}

          {geo.runs.map((run, idx) => (
            <g key={idx}>
              {run.length > 1 && (
                <polyline
                  fill="none"
                  stroke="rgb(var(--accent-primary))"
                  strokeWidth="2.5"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  points={run.map((r) => `${geo.x(r.i)},${geo.y(r.v)}`).join(' ')}
                />
              )}
            </g>
          ))}

          {points.map((p, i) =>
            p.value === null ? null : (
              <circle
                key={p.date}
                cx={geo.x(i)}
                cy={geo.y(p.value)}
                r={active === i ? 6 : 4}
                fill="rgb(var(--accent-primary))"
                stroke="rgb(var(--bg-secondary))"
                strokeWidth="2"
                tabIndex={0}
                role="img"
                aria-label={`${p.date}: ${p.value} from ${p.responses} response${p.responses === 1 ? '' : 's'}`}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                className="outline-none focus-visible:stroke-[rgb(var(--accent-primary))]"
              />
            ),
          )}

          {points.map((p, i) =>
            i % labelEvery === 0 || i === points.length - 1 ? (
              <text key={p.date} x={geo.x(i)} y={H - 8} textAnchor="middle" fontSize="11" fill="currentColor" className="text-text-secondary">
                {p.date.slice(5)}
              </text>
            ) : null,
          )}
        </svg>

        {activePoint && activePoint.value !== null && (
          <div className="pointer-events-none absolute right-2 top-2 rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs shadow-card dark:shadow-card-dark" role="status">
            <div className="font-semibold text-text-primary">{activePoint.date}</div>
            <div className="text-text-secondary">
              {type === 'nps' ? 'NPS' : 'CSAT'} {activePoint.value}
              {type === 'csat' ? '%' : ''} · {activePoint.responses} response{activePoint.responses === 1 ? '' : 's'}
            </div>
          </div>
        )}
      </div>

      {!hasData && (
        <figcaption className="mt-2 text-center text-sm text-text-secondary">
          No responses in this period yet — the line appears as soon as customers answer.
        </figcaption>
      )}

      <table className="sr-only">
        <caption>{type === 'nps' ? 'NPS' : 'CSAT'} by day</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Score</th>
            <th scope="col">Responses</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.date}>
              <td>{p.date}</td>
              <td>{p.value ?? 'no data'}</td>
              <td>{p.responses}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
