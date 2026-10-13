import { describe, expect, it } from 'vitest';
import { transformLocale, transformRtl } from './i18n-codemod-lib.mjs';

describe('transformRtl', () => {
  it('converts physical spacing, alignment, borders, radius and offsets', () => {
    const { code } = transformRtl('<div className="ml-2 -mr-1 md:pl-4 pr-3 text-left border-l-2 rounded-r-xl left-0 -right-2">');
    expect(code).toBe('<div className="ms-2 -me-1 md:ps-4 pe-3 text-start border-s-2 rounded-e-xl start-0 -end-2">');
  });

  it('does not touch lookalikes (rounded-lg, html-ml, border-lg) or symmetric classes', () => {
    const src = '<p className="rounded-lg html-ml-1 mx-2 px-3 text-center">';
    expect(transformRtl(src).code).toBe(src);
  });

  it('leaves the centering idiom alone and does not report it', () => {
    const src = '<span className="absolute left-1/2 -translate-x-1/2">';
    const r = transformRtl(src);
    expect(r.code).toBe(src);
    expect(r.skipped).toEqual([]);
  });

  it('reports other left/right + translate/rotate/origin combos for manual review', () => {
    const r = transformRtl('<i className="absolute left-2 -translate-x-4" />');
    expect(r.skipped).toHaveLength(1);
    expect(r.code).toContain('left-2');
  });

  it('pairs translate-x with an rtl: counterpart', () => {
    expect(transformRtl("<i className={on ? 'translate-x-5' : 'translate-x-0.5'} />").code).toBe(
      "<i className={on ? 'translate-x-5 rtl:-translate-x-5' : 'translate-x-0.5 rtl:-translate-x-0.5'} />",
    );
    expect(transformRtl('<u className="-translate-x-full" />').code).toBe('<u className="-translate-x-full rtl:translate-x-full" />');
    expect(transformRtl('<b className="group-hover:translate-x-1" />').code).toBe(
      '<b className="group-hover:translate-x-1 rtl:group-hover:-translate-x-1" />',
    );
  });

  it('is idempotent', () => {
    const once = transformRtl('<i className="ml-2 translate-x-5 text-right" />').code;
    expect(transformRtl(once).code).toBe(once);
    expect(transformRtl(once).changes).toBe(0);
  });

  it('honours i18n-codemod-ignore', () => {
    const src = '<div className="ml-2"> {/* i18n-codemod-ignore */}';
    expect(transformRtl(src).code).toBe(src);
  });
});

describe('transformLocale', () => {
  const src = [
    "import a from 'a';",
    'import {',
    '  b,',
    "} from 'b';",
    "const x = d.toLocaleDateString('en-US', { month: 'short' });",
    'const y = n.toLocaleString();',
    "const z = t.toLocaleTimeString([], { hour: 'numeric' });",
    "const w = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(1);",
    'const v = q.toLocaleString(undefined, { maximumFractionDigits: 0 });',
  ].join('\n');

  it('injects the active locale and adds one import after the last import', () => {
    const { code, changes } = transformLocale(src);
    expect(changes).toBe(5);
    expect(code).toContain("d.toLocaleDateString(getActiveLocale(), { month: 'short' })");
    expect(code).toContain('n.toLocaleString(getActiveLocale())');
    expect(code).toContain("t.toLocaleTimeString(getActiveLocale(), { hour: 'numeric' })");
    expect(code).toContain('new Intl.NumberFormat(getActiveLocale(), {');
    expect(code).toContain('q.toLocaleString(getActiveLocale(), {');
    const lines = code.split('\n');
    expect(lines[4]).toBe("import { getActiveLocale } from '@/lib/format';");
    expect(code.match(/import \{ getActiveLocale \}/g)).toHaveLength(1);
  });

  it('keeps explicit non-English locales and is idempotent', () => {
    const explicit = "const a = d.toLocaleDateString('fr-FR');";
    expect(transformLocale(explicit)).toEqual({ code: explicit, changes: 0 });
    const once = transformLocale(src).code;
    expect(transformLocale(once).changes).toBe(0);
  });
});
