import { describe, expect, it, vi } from 'vitest';

describe('getPublicOrigin', () => {
  it('uses the browser origin on the web', async () => {
    vi.resetModules();
    vi.doMock('@/lib/native/platform', () => ({ isNative: () => false }));
    const { getPublicOrigin } = await import('./appOrigin');
    expect(getPublicOrigin()).toBe(window.location.origin);
  });

  it('uses the public site origin inside the native app', async () => {
    vi.resetModules();
    vi.doMock('@/lib/native/platform', () => ({ isNative: () => true }));
    const { getPublicOrigin } = await import('./appOrigin');
    expect(getPublicOrigin()).toBe('https://vireek.com');
  });
});
