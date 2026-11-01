import { describe, expect, it } from 'vitest';
import { PREVIEW_SAMPLES } from './previewSamples';

describe('preview samples', () => {
  it.each(PREVIEW_SAMPLES.map((s) => [s.id, s] as const))('%s renders html + text in en and fa without leftovers', (_id, s) => {
    for (const locale of ['en', 'fa', 'de']) {
      const m = s.render(locale, 'https://app.vireek.com');
      expect(m.html.startsWith('<!doctype html>')).toBe(true);
      expect(m.html).not.toMatch(/undefined|\[object Object\]|\{[a-zA-Z]+\}/);
      expect(m.text).not.toMatch(/undefined|\[object Object\]|\{[a-zA-Z]+\}/);
      expect(m.text.length).toBeGreaterThan(40);
    }
  });
  it('has unique ids', () => {
    expect(new Set(PREVIEW_SAMPLES.map((s) => s.id)).size).toBe(PREVIEW_SAMPLES.length);
  });
});
