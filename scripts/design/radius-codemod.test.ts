import { describe, expect, it } from 'vitest';
import { applyEdits, planEdits } from './radius-codemod.mjs';
import { scanSource } from './lib/radius-classify.mjs';

type Edit = { pos: number; end: number; from: string; to: string };
const run = (code: string, step: 'legacy-md' | 'roles' | 'finish', file = 'src/components/Demo.tsx') => {
  const recs = scanSource(code, file);
  const edits = planEdits(recs, step, {}) as Edit[];
  return { out: applyEdits(code, edits).text as string, edits };
};

describe('radius codemod', () => {
  it('legacy-md: only rounded-md changes, side and responsive variants preserved', () => {
    const { out } = run(`const A = () => <div className="rounded-md md:rounded-md rounded-t-md rounded-lg p-2" />;`, 'legacy-md');
    expect(out).toContain('rounded-legacy-md md:rounded-legacy-md rounded-t-legacy-md rounded-lg');
  });

  it('roles: button -> control, card -> surface, modal -> overlay, chip -> chip', () => {
    const { out } = run(`export const A = () => (<>
      <button className="rounded-xl bg-cta px-4 py-2" />
      <article className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card" />
      <div role="dialog" className="rounded-xl border bg-bg-secondary p-6" />
      <span className="rounded-lg bg-bg-tertiary px-2 py-0.5 text-xs" />
    </>);`, 'roles');
    expect(out).toContain('rounded-control bg-cta');
    expect(out).toContain('rounded-surface border border-border');
    expect(out).toContain('rounded-overlay border bg-bg-secondary');
    expect(out).toContain('rounded-chip bg-bg-tertiary');
  });

  it('roles: bottom sheet keeps its side (rounded-t-2xl -> rounded-t-overlay)', () => {
    const { out } = run(`export const A = () => <div role="dialog" className="fixed inset-x-0 bottom-0 rounded-t-2xl bg-bg-secondary" />;`, 'roles');
    expect(out).toContain('rounded-t-overlay');
  });

  it('roles: never touches circles, pills, none, bare/sm, single-corner tails or em-relative radii', () => {
    const src = `export const A = () => (<>
      <div className="h-10 w-10 rounded-full" />
      <button className="rounded-full bg-cta px-4 py-2" />
      <div role="dialog" className="rounded-none sm:rounded-2xl bg-bg-secondary" />
      <article className="rounded border bg-bg-secondary p-4 shadow-card" />
      <article className="rounded-sm border bg-bg-secondary p-4 shadow-card" />
      <div className="rounded-bl-sm border bg-bg-secondary p-4" />
      <article className="rounded-[0.9em] border bg-bg-secondary p-4 shadow-card" />
    </>);`;
    const { out } = run(src, 'roles');
    for (const keep of ['h-10 w-10 rounded-full', 'rounded-full bg-cta', 'rounded-none', 'rounded border', 'rounded-sm border', 'rounded-bl-sm', 'rounded-[0.9em]']) expect(out).toContain(keep);
    expect(out).toContain('sm:rounded-overlay'); // the responsive large radius on the modal IS migrated
  });

  it('is idempotent: a second run changes nothing', () => {
    const code = `export const A = () => (<><button className="rounded-xl bg-cta px-4 py-2" /><article className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card" /></>);`;
    const once = run(code, 'roles').out;
    expect(run(once, 'roles').edits).toHaveLength(0);
    expect(run(run(code, 'legacy-md').out, 'legacy-md').edits).toHaveLength(0);
  });

  it('applyEdits refuses to write when the source changed under a span', () => {
    const r = applyEdits('const x = "rounded-lg";', [{ pos: 0, end: 7, from: 'rounded', to: 'XX' }]);
    expect(r.skipped).toHaveLength(1);
    expect(r.text).toBe('const x = "rounded-lg";');
  });

  it('finish: leftover legacy-md becomes rounded-xl (same 12px) when the role is unknown', () => {
    const { out } = run(`const A = () => <div className="rounded-legacy-md p-1" />;`, 'finish');
    expect(out).toContain('rounded-xl');
  });

  it('finish: single-corner chat-bubble tails become rounded-*-sm, not 12px', () => {
    const { out } = run(`const A = () => <div className="rounded-inset rounded-bl-legacy-md bg-bg-tertiary px-3 py-2" />;`, 'finish');
    expect(out).toContain('rounded-bl-sm');
  });

  it('roles: tiny inline chips without text-xs (px-1.5 py-0.5 span) become rounded-chip', () => {
    const { out } = run(`const A = () => <span className="rounded-legacy-md px-1.5 py-0.5 font-medium" />;`, 'roles');
    expect(out).toContain('rounded-chip');
  });
});
