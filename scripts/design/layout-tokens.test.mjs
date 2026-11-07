import { describe, expect, it } from 'vitest';
import config from '../../tailwind.config.js';
import { Z_LAYERS, transformSource, classifyLayer } from './layout-tokens.mjs';
import { scanSource } from './layout-guard.mjs';

const t = (s, f = 'src/components/X.tsx') => transformSource(s, f).code;

describe('z scale', () => {
  it('has strictly increasing, unique values in the documented order', () => {
    const order = ['behind', 'base', 'raised', 'dropdown', 'sticky', 'banner', 'overlay', 'modal', 'command', 'popover', 'toast', 'tooltip', 'blocking', 'skip', 'max'];
    expect(Object.keys(Z_LAYERS)).toEqual(order);
    const v = Object.values(Z_LAYERS);
    expect(v).toEqual([...v].sort((a, b) => a - b));
    expect(new Set(v).size).toBe(v.length);
  });
  it('tailwind config exposes exactly the same layers', () => {
    expect(config.theme.extend.zIndex).toEqual(Z_LAYERS);
  });
  it('real stacking requirements hold', () => {
    const z = Z_LAYERS;
    expect(z.sticky).toBeLessThan(z.banner);
    expect(z.banner).toBeLessThan(z.overlay);
    expect(z.modal).toBeLessThan(z.popover);
    expect(z.popover).toBeLessThan(z.toast);
    expect(z.toast).toBeLessThan(z.tooltip);
    expect(z.tooltip).toBeLessThan(z.blocking);
  });
});

describe('codemod', () => {
  it('maps dialog backdrop/panel pairs', () => {
    expect(t('<div className="fixed inset-0 z-[110] bg-black/40">')).toContain('z-overlay');
    expect(t('<div className="fixed left-1/2 top-1/2 z-[120] -translate-x-1/2">')).toContain('z-modal');
  });
  it('keeps variants and leaves negative/unknown z alone', () => {
    expect(t('<div className="sm:fixed sm:inset-0 sm:z-[110]">')).toContain('sm:z-overlay');
    expect(t('<div className="static z-[999]">')).toContain('z-[999]');
    expect(t('<div className="absolute inset-0 -z-10">')).toContain('z-behind');
  });
  it('maps shadows and only pixel-identical spacing', () => {
    expect(t('<div className="shadow-lg hover:shadow-xl shadow-card">')).toBe('<div className="shadow-elevation-3 hover:shadow-elevation-4 shadow-card">');
    expect(t('<div className="min-h-[44px] max-w-[640px] gap-[8px] w-[37px]">')).toBe('<div className="min-h-touch max-w-panel-xl gap-2 w-[37px]">');
  });
  it('never rewrites dynamic / env values or comments', () => {
    const src = '<div className="pb-[max(1rem,env(safe-area-inset-bottom))] h-[var(--h)] w-[1em]">';
    expect(t(src)).toBe(src);
    expect(t('// z-[999] shadow-lg\n')).toBe('// z-[999] shadow-lg\n');
  });
  it('is idempotent', () => {
    const once = t('<div className="fixed inset-0 z-[110] shadow-2xl min-h-[44px]">');
    expect(t(once)).toBe(once);
  });
  it('overrides by file', () => {
    expect(classifyLayer('x', 400, 'src/components/ui/Tooltip.tsx')).toBe('tooltip');
  });
});

describe('guard', () => {
  const rules = (s) => scanSource(s).map((v) => v.rule);
  it('flags arbitrary layout, numeric z, raw shadows, static inline style', () => {
    expect(rules('<div className="w-[37px]">')).toEqual(['no-arbitrary-layout']);
    expect(rules('<div className="z-50">')).toEqual(['no-numeric-z']);
    expect(rules('<div className="shadow-lg">')).toEqual(['no-raw-shadow']);
    expect(rules("<div style={{ marginTop: 2 }} />")).toEqual(['no-static-inline-style']);
  });
  it('allows tokens, dynamic values, css variables and ds-allow', () => {
    expect(rules('<div className="z-modal shadow-elevation-2 min-h-touch h-[var(--h)]" style={{ height: h }} />')).toEqual([]);
    expect(rules("<div style={cssVars({ '--w': '4px' })} />")).toEqual([]);
    expect(rules('{/* ds-allow: third-party override */}\n<div className="w-[37px]">')).toEqual([]);
  });
});
