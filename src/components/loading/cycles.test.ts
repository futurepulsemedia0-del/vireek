import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BOOT_CYCLE_MS, LOADER_CYCLE_MS, ROUTE_MIN_CYCLE_MS } from '@/components/loading/cycles';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const css = read('./brand-loader.css');
const html = read('../../../index.html');

/** Duration in ms of `animation: <name> <N>s …` and whether it loops forever. */
function anim(source: string, name: string) {
  const m = source.match(new RegExp(`animation:\\s*${name}\\s+([\\d.]+)s([^;}]*)`));
  if (!m) throw new Error(`animation ${name} not found`);
  return { ms: Math.round(parseFloat(m[1]) * 1000), infinite: /\binfinite\b/.test(m[2]) };
}

describe('loader cycles stay in step with the CSS and never stop', () => {
  const cases = [
    ['thread', 'vrkv-thread-m'],
    ['fill', 'vrkv-fill-m'],
    ['signal', 'vrkv-ring'],
    ['network', 'vrkv-bloom'],
    ['pulse', 'vrkv-pulse-p'],
  ] as const;

  it.each(cases)('%s: duration matches and loops forever', (variant, name) => {
    const a = anim(css, name);
    expect(a.ms).toBe(LOADER_CYCLE_MS[variant]);
    expect(a.infinite).toBe(true);
  });

  it('launch splash (index.html): duration matches and both loops are infinite', () => {
    for (const name of ['vb-m', 'vb-n']) {
      const a = anim(html, name);
      expect(a.ms).toBe(BOOT_CYCLE_MS);
      expect(a.infinite).toBe(true);
    }
  });

  it('route pages wait one full pulse loop', () => {
    expect(ROUTE_MIN_CYCLE_MS).toBe(LOADER_CYCLE_MS.pulse);
  });
});
