import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildCodeSamples, WEBHOOK_VERIFY_SAMPLES } from '../../supabase/functions/api-v1/contract';
import {
  HIGHLIGHT_THEME,
  contrastRatio,
  langOfTab,
  tokenize,
  type HighlightLang,
} from './highlight';

const css = readFileSync(`${process.cwd()}/src/index.css`, 'utf8');

describe('tokenize', () => {
  it('is lossless for every documented sample in every language', () => {
    const samples = [
      ...buildCodeSamples('https://h.example/api-v1/calls?limit=25').map(
        (s) => [langOfTab(s.id), s.source] as const,
      ),
      ...WEBHOOK_VERIFY_SAMPLES.map((s) => [langOfTab(s.id), s.source] as const),
      ['json', '{ "a": [1, 2.5, true, null], "b": "x\\"y" }'] as const,
    ];
    for (const [lang, src] of samples)
      expect(
        tokenize(src, lang as HighlightLang)
          .map((t) => t.text)
          .join(''),
      ).toBe(src);
  });

  it('classifies strings, comments, numbers and keywords', () => {
    const kinds = (code: string, lang: HighlightLang) =>
      Object.fromEntries(
        tokenize(code, lang)
          .filter((t) => t.type !== 'text')
          .map((t) => [t.text, t.type]),
      );
    expect(kinds('const x = "a // not a comment" // real', 'javascript')).toEqual({
      const: 'keyword',
      '"a // not a comment"': 'string',
      '// real': 'comment',
    });
    expect(kinds('x = 42 # note', 'python')).toEqual({ '42': 'number', '# note': 'comment' });
    expect(kinds('curl -sS "u" # c', 'shell')).toMatchObject({
      curl: 'keyword',
      '-sS': 'property',
      '"u"': 'string',
      '# c': 'comment',
    });
    expect(kinds('func main() { return nil }', 'go')).toMatchObject({
      func: 'keyword',
      return: 'keyword',
      nil: 'keyword',
    });
  });

  it('handles pathological input in linear time', () => {
    const evil = `"${'\\'.repeat(50_000)}`;
    const t0 = performance.now();
    tokenize(evil + '\n' + '/*'.repeat(20_000), 'javascript');
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe('theme accessibility', () => {
  it.each(['light', 'dark'] as const)(
    'every %s token color meets WCAG AA (>= 4.5:1) on the code background',
    (mode) => {
      const t = HIGHLIGHT_THEME[mode];
      for (const k of ['text', 'comment', 'string', 'number', 'keyword', 'property'] as const) {
        expect(contrastRatio(t[k], t.bg), `${mode} ${k}`).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it('the theme background matches --bg-primary in index.css and the token variables are defined there', () => {
    const root = /:root\s*\{([^}]*)\}/.exec(css)![1];
    const dark = /\.dark\s*\{([^}]*)\}/.exec(css)![1];
    expect(root).toContain(`--bg-primary: ${HIGHLIGHT_THEME.light.bg.join(' ')}`);
    expect(dark).toContain(`--bg-primary: ${HIGHLIGHT_THEME.dark.bg.join(' ')}`);
    for (const [mode, block] of [
      ['light', css.match(/:root\s*\{[^}]*--tok-keyword[^}]*\}/)?.[0]],
      ['dark', css.match(/\.dark\s*\{[^}]*--tok-keyword[^}]*\}/)?.[0]],
    ] as const) {
      expect(block, `${mode} token vars`).toBeTruthy();
      for (const k of ['comment', 'string', 'number', 'keyword', 'property'] as const)
        expect(block).toContain(`--tok-${k}: ${HIGHLIGHT_THEME[mode][k].join(' ')}`);
    }
  });
});
