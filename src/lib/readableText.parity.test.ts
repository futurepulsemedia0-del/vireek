// The embed scripts and the edge function cannot import src/lib/readableText.ts, so each carries a marked copy of the
// algorithm. This test extracts every copy, runs it, and requires the SAME answer as the canonical module on a 4096-point grid.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { readableTextColor } from './readableText';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const between = (src: string): string => {
  const m = /<readable-text>[^\n]*\n([\s\S]*?)\/\/ <\/readable-text>/.exec(src);
  if (!m || !m[1]) throw new Error('missing <readable-text> markers');
  return m[1];
};
type Fn = (hex: string) => string;

const copies: Array<[string, () => Fn]> = [
  ['public/chat-widget.js', () => new Function(`${between(read('../../public/chat-widget.js'))}; return textOn;`)() as Fn],
  ['public/website-widgets.js', () => new Function(`${between(read('../../public/website-widgets.js'))}; return textOn;`)() as Fn],
  ['supabase/functions/_shared/direct-mail/engine.ts', () => {
    const code = between(read('../../supabase/functions/_shared/direct-mail/engine.ts'))
      .replace('export function readableTextColor(hex: string): string', 'function readableTextColor(hex)')
      .replace('(r: number, g: number, b: number): number =>', '(r, g, b) =>');
    return new Function(`${code}; return readableTextColor;`)() as Fn;
  }],
];

describe.each(copies)('readable-text parity: %s', (_name, load) => {
  it('matches src/lib/readableText.ts on every grid colour and on invalid input', () => {
    const fn = load();
    const grid: string[] = ['bad', '', '#fff', 'F97316'];
    for (let r = 0; r < 256; r += 17) for (let g = 0; g < 256; g += 17) for (let b = 0; b < 256; b += 17) grid.push(`#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`);
    for (const c of grid) expect(fn(c)).toBe(readableTextColor(c));
  });
});
