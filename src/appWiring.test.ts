import { describe, expect, it } from 'vitest';
import appSrc from '@/App.tsx?raw';
import paymentsSrc from '@/pages/PaymentsPage.tsx?raw';
import voiceSrc from '@/pages/VoiceStudioPage.tsx?raw';
import en from '@/locales/en/common.json';
import fa from '@/locales/fa/common.json';

const count = (s: string, n: string) => s.split(n).length - 1;
const keys = (o: unknown, p = ''): string[] =>
  o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => keys(v, p ? `${p}.${k}` : k)) : [p];

describe('shell + staff + dev wiring', () => {
  it('mounts the update prompt and network strip once', () => {
    expect(count(appSrc, '<UpdatePrompt />')).toBe(1);
    expect(count(appSrc, '<NetworkStatusStrip />')).toBe(1);
  });
  it('staff assistant-gaps route sits behind StaffRoute', () => {
    const i = appSrc.indexOf('path="/staff/assistant-gaps"');
    expect(i).toBeGreaterThan(-1);
    expect(appSrc.slice(i, appSrc.indexOf('\n', i))).toContain('<StaffRoute>');
  });
  it('dev pages are only built when the dev flag is on', () => {
    for (const n of ['StatesPage', 'DocumentsGalleryPage', 'TokensPreview'])
      expect(appSrc).toContain(`const ${n} = DEV_PAGES_ON ?`);
  });
  it('payout card renders only when Stripe is connected', () => {
    expect(paymentsSrc).toContain('{connected && <InstantPayoutCard />}');
  });
  it('voice studio mounts the experiments panel', () => {
    expect(voiceSrc).toContain('<ExperimentsPanel />');
  });
  it('net.* strings exist in en and fa with the same keys', () => {
    const e = keys((en as Record<string, unknown>).net, 'net').sort();
    const f = keys((fa as Record<string, unknown>).net, 'net').sort();
    expect(e.length).toBeGreaterThan(0);
    expect(f).toEqual(e);
  });
});
