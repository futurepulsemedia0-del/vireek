import { LOGO_SHAPES, WORDMARK_DOT, WORDMARK_METRICS } from './logoPaths.generated';

/**
 * Brand-guideline diagram: the wordmark with its construction lines and the
 * clear-space box. Purely illustrative (aria-hidden, described by the caption
 * in the page); numbers come from the generated artwork so it cannot drift.
 */
export function LogoConstruction({ mode }: { mode: 'grid' | 'clearspace' }) {
  const s = LOGO_SHAPES.wordmark;
  const { baseline, cap, xh } = WORDMARK_METRICS;
  const x = (baseline - cap) / 2; // clear space unit = half the height of the V
  const pad = mode === 'clearspace' ? x : 60;
  const vb = mode === 'grid' ? `-60 -60 ${s.w + 60 + 760} ${s.h + 120}` : `${-pad} ${-pad} ${s.w + pad * 2} ${s.h + pad * 2}`;
  const line = { stroke: 'rgb(var(--logo-accent, 193 79 38))', strokeWidth: 5, strokeDasharray: '14 10', opacity: 0.9 } as const;
  const label = { fontSize: 96, fill: 'rgb(var(--text-secondary, 103 103 112))', fontFamily: 'Inter, system-ui, sans-serif' } as const;
  return (
    <svg viewBox={vb} className="h-auto w-full" aria-hidden="true">
      {mode === 'clearspace' && (
        <>
          <rect x={-x} y={-x} width={s.w + x * 2} height={s.h + x * 2} fill="rgb(var(--accent-primary, 32 58 216) / 0.06)" stroke="rgb(var(--accent-primary, 32 58 216))" strokeWidth={3} strokeDasharray="14 10" />
          <rect x={0} y={0} width={s.w} height={s.h} fill="var(--bg-card, #fff)" opacity={0.0} />
          {[
            [s.w / 2 - x / 2, -x],
            [s.w / 2 - x / 2, s.h],
            [-x, s.h / 2 - x / 2],
            [s.w, s.h / 2 - x / 2],
          ].map(([bx, by], i) => (
            <g key={i}>
              <rect x={bx} y={by} width={x} height={x} fill="rgb(var(--accent-primary, 32 58 216) / 0.16)" />
              <text x={bx + x / 2} y={by + x / 2 + 16} textAnchor="middle" {...label}>x</text>
            </g>
          ))}
        </>
      )}
      {mode === 'grid' && (
        <>
          {[
            [0, ''],
            [cap, 'cap'],
            [xh, 'x-height'],
            [baseline, 'baseline'],
          ].map(([y, t]) => (
            <g key={String(t)}>
              <line x1={-40} x2={s.w + 40} y1={y as number} y2={y as number} {...line} />
              <text x={s.w + 50} y={(y as number) + 14} {...label}>{t}</text>
            </g>
          ))}
          <circle cx={WORDMARK_DOT.cx} cy={WORDMARK_DOT.cy} r={WORDMARK_DOT.r + 10} fill="none" {...line} />
          <line x1={WORDMARK_DOT.cx} x2={WORDMARK_DOT.cx} y1={-30} y2={s.h + 30} {...line} />
        </>
      )}
      {s.layers.map(([role, d], i) => (
        <path key={i} d={d} fill={role === 'ink' ? 'rgb(var(--accent-primary, 32 58 216))' : 'rgb(var(--logo-accent, 193 79 38))'} />
      ))}
    </svg>
  );
}
