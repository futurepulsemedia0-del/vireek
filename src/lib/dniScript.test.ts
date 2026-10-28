// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Runs the real public/dni.js in jsdom: number swapping must keep the page's own formatting and never touch the wrong things. */
interface Api {
  swapText: (t: string, from: string, to: string) => string;
  swapHref: (h: string, from: string, to: string) => string;
  isBot: (ua: string, wd?: boolean) => boolean;
  readSignals: (url: string, ref: string) => Record<string, string>;
  show: (def: string, cur: string) => void;
  state: { texts: unknown[]; attrs: unknown[]; marked: unknown[]; def: string | null; cur: string | null };
}
let api: Api;
const DEF = '+15551234567';
const NEW = '+15559876543';

beforeAll(() => {
  new Function(readFileSync(resolve(__dirname, '../../public/dni.js'), 'utf8'))();
  api = (window as unknown as { __vireekDNI: { _api: Api } }).__vireekDNI._api;
});

beforeEach(() => {
  document.body.innerHTML = '';
  Object.assign(api.state, { texts: [], attrs: [], marked: [], def: null, cur: null });
});

describe('text swapping', () => {
  it.each([
    ['Call (555) 123-4567 now', 'Call (555) 987-6543 now'],
    ['555-123-4567', '555-987-6543'],
    ['555.123.4567', '555.987.6543'],
    ['+1 (555) 123-4567', '+1 (555) 987-6543'],
    ['1-555-123-4567', '1-555-987-6543'],
    ['15551234567', '15559876543'],
  ])('keeps the original style: %s', (input, expected) => {
    expect(api.swapText(input, DEF, NEW)).toBe(expected);
  });
  it('does not touch longer digit runs or other numbers', () => {
    expect(api.swapText('ref 9555123456789', DEF, NEW)).toBe('ref 9555123456789');
    expect(api.swapText('555-123-45678', DEF, NEW)).toBe('555-123-45678');
    expect(api.swapText('(555) 111-2222', DEF, NEW)).toBe('(555) 111-2222');
  });
  it('falls back to international format when the digit count differs', () => {
    expect(api.swapText('(555) 123-4567', DEF, '+442071234567')).toBe('+442071234567');
  });
});

describe('tel: links', () => {
  it('rewrites only links that point at the normal number', () => {
    expect(api.swapHref('tel:+15551234567', DEF, NEW)).toBe('tel:+15559876543');
    expect(api.swapHref('tel:555-123-4567', DEF, NEW)).toBe('tel:+15559876543');
    expect(api.swapHref('tel:+19990000000', DEF, NEW)).toBe('tel:+19990000000');
    expect(api.swapHref('mailto:a@b.com', DEF, NEW)).toBe('mailto:a@b.com');
  });
});

describe('page replacement', () => {
  it('swaps text, tel links and data-vireek-number, and restores when the number changes back', () => {
    document.body.innerHTML = `
      <p id="t">Call us: (555) 123-4567</p>
      <a id="l" href="tel:+15551234567">Tap to call</a>
      <span id="m" data-vireek-number>(555) 123-4567</span>
      <script id="s">var n = "(555) 123-4567";</script>
      <p data-vireek-dni-ignore id="ig">(555) 123-4567</p>
      <p id="other">(555) 111-2222</p>`;
    api.show(DEF, NEW);
    expect(document.getElementById('t')!.textContent).toBe('Call us: (555) 987-6543');
    expect(document.getElementById('l')!.getAttribute('href')).toBe('tel:+15559876543');
    expect(document.getElementById('m')!.textContent).toBe('(555) 987-6543');
    expect(document.getElementById('s')!.textContent).toContain('(555) 123-4567');
    expect(document.getElementById('ig')!.textContent).toBe('(555) 123-4567');
    expect(document.getElementById('other')!.textContent).toBe('(555) 111-2222');
    api.show(DEF, DEF);
    expect(document.getElementById('t')!.textContent).toBe('Call us: (555) 123-4567');
    expect(document.getElementById('l')!.getAttribute('href')).toBe('tel:+15551234567');
  });
  it('is a no-op for a page without the number', () => {
    document.body.innerHTML = '<p id="x">Hello</p>';
    api.show(DEF, NEW);
    expect(document.getElementById('x')!.textContent).toBe('Hello');
    expect(api.state.texts).toHaveLength(0);
  });
});

describe('visit signals', () => {
  it('reads marketing parameters and the path only', () => {
    const s = api.readSignals('https://acme.com/ac?utm_source=Google&utm_medium=cpc&gclid=g1&email=a%40b.com#top', 'https://www.google.com/');
    expect(s).toMatchObject({ utm_source: 'Google', utm_medium: 'cpc', click_id_type: 'gclid', click_id: 'g1', landing_path: '/ac', referrer: 'https://www.google.com/' });
    expect(JSON.stringify(s)).not.toContain('a@b.com');
  });
  it('survives malformed escapes', () => {
    expect(() => api.readSignals('https://acme.com/?utm_source=%E0%A4%A', '')).not.toThrow();
  });
});

describe('bot guard', () => {
  it('skips crawlers and automation, not browsers', () => {
    expect(api.isBot('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe(true);
    expect(api.isBot('Chrome-Lighthouse')).toBe(true);
    expect(api.isBot('Mozilla/5.0 Chrome/120 Safari/537.36')).toBe(false);
    expect(api.isBot('Mozilla/5.0', true)).toBe(true);
  });
});
