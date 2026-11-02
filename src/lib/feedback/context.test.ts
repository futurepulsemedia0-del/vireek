import { describe, expect, it } from 'vitest';
import { parseBrowser } from './context';

describe('parseBrowser', () => {
  it('is coarse: name + major version only', () => {
    const r = parseBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
    expect(r).toEqual({ browser: 'Chrome 130', os: 'macOS' });
    expect(parseBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/131.0').browser).toBe('Firefox 131');
  });
});
