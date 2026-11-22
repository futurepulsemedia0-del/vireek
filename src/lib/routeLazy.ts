import type { ComponentType } from 'react';
import { safeLazy } from '@/lib/safeLazy';
import { ROUTE_MIN_CYCLE_MS } from '@/components/loading/cycles';

/**
 * Drop-in for safeLazy for ROUTE pages only. If the chunk arrives faster than one full loop of the
 * route loader, the page is held back so the loader is seen complete once. Skipped while the launch
 * splash is still on screen (it already played a full loop) and in tests. Cached chunks never suspend,
 * so this only costs the first visit to each page per launch.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function routeLazy<T extends ComponentType<any>>(factory: () => Promise<{ default: T }>) {
  return safeLazy(async () => {
    const startedAt = performance.now();
    const mod = await factory();
    if (import.meta.env.MODE !== 'test' && !document.getElementById('vrk-boot')) {
      const wait = ROUTE_MIN_CYCLE_MS - (performance.now() - startedAt);
      if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
    return mod;
  });
}
