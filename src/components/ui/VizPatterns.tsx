import { VIZ_PATTERNS } from '@/styles/tokens.generated';

/**
 * SVG <defs> with one pattern per categorical series (id `viz-pattern-1…8`) so charts never rely on colour alone.
 * Render once inside any chart <svg>, then use  fill="url(#viz-pattern-3)"  — each pattern is drawn in
 * the series colour (--viz-N) over a lighter wash, with a distinct texture.
 */
export function VizPatternDefs() {
  return (
    <defs>
      {VIZ_PATTERNS.map((kind, i) => {
        const n = i + 1;
        const c = `rgb(var(--viz-${n}))`;
        const bg = `rgb(var(--viz-${n}) / 0.18)`;
        return (
          <pattern key={kind} id={`viz-pattern-${n}`} width="8" height="8" patternUnits="userSpaceOnUse">
            <rect width="8" height="8" fill={kind === 'solid' ? c : bg} />
            {kind === 'diagonal' && <path d="M-2 2l4-4M0 8l8-8M6 10l4-4" stroke={c} strokeWidth="1.6" />}
            {kind === 'dots' && <circle cx="4" cy="4" r="1.6" fill={c} />}
            {kind === 'cross' && <path d="M0 0l8 8M8 0l-8 8" stroke={c} strokeWidth="1.2" />}
            {kind === 'horizontal' && <path d="M0 4h8" stroke={c} strokeWidth="1.6" />}
            {kind === 'vertical' && <path d="M4 0v8" stroke={c} strokeWidth="1.6" />}
            {kind === 'checker' && <path d="M0 0h4v4H0zM4 4h4v4H4z" fill={c} />}
            {kind === 'zigzag' && <path d="M0 6l2-4 2 4 2-4 2 4" fill="none" stroke={c} strokeWidth="1.4" />}
          </pattern>
        );
      })}
    </defs>
  );
}
