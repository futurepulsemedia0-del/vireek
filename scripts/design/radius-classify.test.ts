import { describe, expect, it } from 'vitest';
import { scanSource, classify, ROLE_TARGET, SMALL_ROLES } from './lib/radius-classify.mjs';
import { RADIUS_PX, RADIUS_ROLES, tailwindBorderRadius } from './radius-tokens.mjs';

type Rec = { role: string; size: string; side: string; responsive: boolean };
const scan = (code: string): Rec[] => scanSource(code, 'src/components/Demo.tsx') as Rec[];

describe('radius tokens', () => {
  it('scale is strictly monotonic', () => {
    const order = ['none', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', 'full'];
    for (let i = 1; i < order.length; i++) expect(RADIUS_PX[order[i]]).toBeGreaterThan(RADIUS_PX[order[i - 1]]);
  });
  it('role aliases resolve to real steps and respect the "small never above lg" rule', () => {
    for (const step of Object.values(RADIUS_ROLES) as string[]) expect(RADIUS_PX[step]).toBeDefined();
    for (const role of SMALL_ROLES as Set<string>) {
      const t = ROLE_TARGET[role];
      if (t && t !== 'full') expect(RADIUS_PX[RADIUS_ROLES[t]]).toBeLessThanOrEqual(RADIUS_PX.lg);
    }
  });
  it('md is no longer larger than lg, and the one-release legacy alias keeps 12px', () => {
    const tw = tailwindBorderRadius();
    expect(parseInt(tw.md)).toBeLessThan(parseInt(tw.lg));
    expect(tw['legacy-md']).toBe('12px');
  });
});

describe('radius scanner', () => {
  it('finds tokens, folds side variants, flags responsive ones', () => {
    const r = scan(`export const A = () => <div className="rounded-xl sm:rounded-2xl rounded-t-lg p-4" />;`);
    expect(r.map((x) => x.size)).toEqual(['xl', '2xl', 'lg']);
    expect(r[1].responsive).toBe(true);
    expect(r[2].side).toBe('t');
  });
  it('ignores prose that merely contains the word "rounded" and import paths', () => {
    expect(scan(`const msg = 'Totals are rounded to the nearest dollar'; import x from './rounded-xl';`)).toHaveLength(0);
  });
  it('classifies by tag, role attribute and class pattern', () => {
    const r = scan(`
      export const A = () => (<>
        <button className="rounded-xl bg-cta px-4 py-2" />
        <input className="w-full rounded-xl border px-3 py-2 focus:ring-2" />
        <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs" />
        <div role="dialog" className="rounded-2xl border bg-bg-secondary p-6 shadow-xl" />
        <div className="h-10 w-10 rounded-full" />
      </>);`);
    expect(r.map((x) => x.role)).toEqual(['button', 'input', 'chip', 'modal', 'avatar']);
  });
  it('does not turn every child of a *Dialog component into a modal', () => {
    const r = scanSourceOf(`export function ConfirmDialog() { return <button className="rounded-xl px-4 py-2 bg-cta" />; }`);
    expect(r[0].role).toBe('button');
  });
  it('square flex tiles are icon tiles, not cards', () => {
    expect(classify({ tag: 'div', cls: 'flex h-10 w-10 items-center justify-center rounded-xl bg-bg-tertiary' }).role).toBe('icon-tile');
  });
});

function scanSourceOf(code: string): Rec[] {
  return scanSource(code, 'src/components/ConfirmDialog.tsx') as Rec[];
}
