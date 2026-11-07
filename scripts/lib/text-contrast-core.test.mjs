// scripts/lib/text-contrast-core.test.mjs — the scanner that powers the audit, the codemod and the guard.
import { describe, it, expect } from 'vitest';
import { scanFile, guardViolations } from './text-contrast-core.mjs';

const scan = (s) => scanFile(s, 'x.tsx').records;
describe('scanFile', () => {
  it('measures alpha text against the real token (fails AA)', () => {
    const [r] = scan('const c = "text-text-secondary/60";');
    expect(r.cls).toBe('meaningful text');
    expect(r.worst).toBeLessThan(4.5);
  });
  it('ignores the text-sm/6 line-height shorthand', () => expect(scan('const c = "text-sm/6 font-medium";')).toHaveLength(0));
  it('classifies disabled: and placeholder: variants', () => {
    expect(scan('"disabled:text-text-secondary/50"')[0].cls).toBe('disabled');
    expect(scan('"placeholder:text-text-secondary/60"')[0].cls).toBe('placeholder');
  });
  it('treats lucide icons as decorative glyphs (3:1 target)', () => {
    const [r] = scan("import { Info } from 'lucide-react';\nconst x = <Info className=\"h-4 w-4 text-text-secondary/50\" />;");
    expect(r.cls).toBe('decorative glyph');
    expect(r.need).toBe(3);
  });
  it('a dark: variant is evaluated in dark only; a sibling dark:text-* limits the base to light', () => {
    expect(scan('"dark:text-text-secondary/70"')[0].modes).toEqual(['dark']);
    expect(scan('"text-text-secondary/70 dark:text-text-primary"')[0].modes).toEqual(['light']);
  });
  it('uses a bg-* from the same class string as the surface', () => expect(scan('"bg-bg-secondary text-text-secondary/70"')[0].surfaceKnown).toBe(true));
  it('white/black text without a known surface is unverifiable, never "passing"', () => {
    const [r] = scan('"text-white/70"');
    expect(r.worst).toBe(null);
    expect(r.unverifiable).toBe('surface unknown (white/black text)');
  });
  it('gradients/images are unverifiable', () => expect(scan('"bg-gradient-to-r from-accent text-text-secondary/70"')[0].unverifiable).toBe('gradient/image'));
  it('does not look inside comments', () => expect(scan('// text-text-secondary/60 is banned\nconst a = 1;')).toHaveLength(0));
});
describe('guardViolations', () => {
  const g = (s) => guardViolations(scan(s));
  it('flags alpha text and opacity on a text-coloured element', () => {
    expect(g('"text-text-secondary/60"')).toHaveLength(1);
    expect(g('"text-text-secondary opacity-60"')).toHaveLength(1);
  });
  it('exempts disabled states, hover reveals, motion and contrast-ok lines', () => {
    expect(g('"disabled:opacity-50 text-text-secondary"')).toHaveLength(0);
    expect(g('"text-text-secondary opacity-0 group-hover:opacity-100"')).toHaveLength(0);
    expect(g('"text-text-secondary opacity-60 transition-opacity"')).toHaveLength(0);
    expect(g('// contrast-ok: watermark, not readable content\nconst c = "text-text-secondary/60";')).toHaveLength(0);
  });
  it('does not flag opacity on an element without a text colour', () => expect(g('"bg-bg-secondary opacity-60"')).toHaveLength(0));
});
