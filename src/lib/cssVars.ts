import type { CSSProperties } from 'react';

export type CssVarName = `--${string}`;

/**
 * Typed helper for data-driven values: set a CSS variable inline, consume it with a token-friendly
 * class (e.g. `h-[var(--bar-h)]`). Pass strings WITH units, e.g. cssVars({ '--bar-h': `${px}px` }).
 * Undefined entries are dropped.
 */
export function cssVars(vars: Partial<Record<CssVarName, string | number | undefined>>): CSSProperties {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) out[k] = v;
  return out as unknown as CSSProperties;
}
