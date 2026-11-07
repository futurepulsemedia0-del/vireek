import { describe, expect, it } from 'vitest';
import { newStats, transform } from './codemod-icons.mjs';
import { tokenForPx, tokenForTw } from './icon-scale.mjs';

const run = (body, opts = {}) => {
  const src = `import { X, Trash2 } from 'lucide-react';\nexport const A = () => (${body});\n`;
  const stats = newStats();
  const out = transform(src, 'a.tsx', opts, stats);
  const prefix = 'export const A = () => (';
  return { out: out.split('\n')[1].slice(prefix.length, -2), stats };
};

describe('icon scale mapping', () => {
  it('maps px to tokens and leaves display icons alone', () => {
    expect([10, 12, 13, 14, 16, 18, 20, 22, 24].map(tokenForPx)).toEqual(['micro', 'micro', 'sm', 'sm', 'sm', 'md', 'md', 'lg', 'lg']);
    expect(tokenForPx(26)).toBeNull();
    expect(tokenForPx(48)).toBeNull();
  });
  it('removes the 3.5 half-step', () => {
    expect([3, 3.5, 4, 5, 6, 7].map(tokenForTw)).toEqual(['micro', 'sm', 'sm', 'md', 'lg', null]);
  });
});

describe('codemod-icons', () => {
  it('size prop -> token class and drops strokeWidth', () => {
    expect(run('<X size={14} strokeWidth={2.5} />').out).toBe('<X className="icon-sm" />');
  });
  it('h-4 w-4 -> token class, keeps the other classes', () => {
    expect(run('<X className="h-4 w-4 text-accent" />').out).toBe('<X className="text-accent icon-sm" />');
  });
  it('h-3.5 w-3.5 becomes sm (half-step removed)', () => {
    expect(run('<X className="h-3.5 w-3.5" />').out).toBe('<X className="icon-sm" />');
  });
  it('works inside cn()/ternaries without touching the dynamic part', () => {
    const { out } = run(`<X className={cn('h-5 w-5', open && 'rotate-180')} />`);
    expect(out).toBe(`<X className={cn('icon-md', open && 'rotate-180')} />`);
  });
  it('never edits a token that touches a template interpolation', () => {
    const { out, stats } = run('<X className={`h-4 w-${n}`} />');
    expect(out).toContain('w-${n}');
    expect(stats.changed).toBe(0);
  });
  it('skips display icons, dynamic sizes, responsive and non-square classes', () => {
    for (const body of ['<X size={32} />', '<X size={big ? 20 : 16} />', '<X className="h-4 w-4 md:h-5 md:w-5" />', '<X className="h-4 w-5" />']) {
      expect(run(body).stats.changed).toBe(0);
    }
  });
  it('does not touch non-lucide elements', () => {
    const src = `export const A = () => <div className="h-4 w-4" />;\n`;
    expect(transform(src, 'a.tsx', {}, newStats())).toBe(src);
  });
  it('is idempotent', () => {
    const once = run('<X size={14} />').out;
    const twice = run(once).out;
    expect(twice).toBe(once);
  });
  it('--targets adds hit-area (+relative) to icon-only buttons only', () => {
    expect(run('<button className="p-1" onClick={f}><X className="h-4 w-4" /></button>', { targets: true }).out).toBe('<button className="p-1 relative hit-area" onClick={f}><X className="icon-sm" /></button>');
    expect(run('<button className="absolute p-1"><X size={16} /></button>', { targets: true }).out).toContain('absolute p-1 hit-area');
    expect(run('<button className="p-1"><X size={16} /> Close</button>', { targets: true }).stats.hitArea).toBe(0);
    expect(run('<button className="overflow-hidden"><X size={16} /></button>', { targets: true }).stats.hitArea).toBe(0);
  });
});
