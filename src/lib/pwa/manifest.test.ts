import { describe, expect, it } from 'vitest';
import raw from '../../../public/site.webmanifest?raw';

const manifest = JSON.parse(raw) as {
  id: string;
  name: string;
  start_url: string;
  scope: string;
  display: string;
  icons: { src: string; sizes: string; purpose?: string }[];
  shortcuts: { name: string; url: string; icons?: unknown[] }[];
};

describe('site.webmanifest (installability)', () => {
  it('has the fields Chromium requires', () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url.startsWith('/')).toBe(true);
    expect(manifest.id).toBeTruthy();
  });

  it('start_url and shortcuts live inside the scope', () => {
    expect(manifest.start_url.startsWith(manifest.scope)).toBe(true);
    for (const s of manifest.shortcuts) expect(s.url.startsWith(manifest.scope)).toBe(true);
  });

  it('ships 192 and 512 icons in both "any" and "maskable" purposes', () => {
    for (const size of ['192x192', '512x512']) {
      for (const purpose of ['any', 'maskable']) {
        expect(manifest.icons.some((i) => i.sizes === size && i.purpose === purpose)).toBe(true);
      }
    }
  });

  it('exposes shortcuts for the bottom-nav destinations', () => {
    const urls = manifest.shortcuts.map((s) => s.url.split('?')[0]);
    expect(urls).toEqual(expect.arrayContaining(['/dashboard/jobs', '/dashboard/calls', '/dashboard/inbox']));
  });
});
