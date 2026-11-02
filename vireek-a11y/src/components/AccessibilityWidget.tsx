import { lazy, Suspense, useEffect, useState } from 'react';

// The whole Accessibility Center (panel, voice, TTS, sync) is code-split and mounted when the browser is idle,
// or immediately when someone asks for it (skip link / shortcut event), so it never competes with first paint.
const Center = lazy(() => import('./a11y/center/AccessibilityCenter').then((m) => ({ default: m.AccessibilityCenter })));

export function AccessibilityWidget() {
  const [ready, setReady] = useState(false);
  const [openFirst, setOpenFirst] = useState(false);
  useEffect(() => {
    const hasIdle = typeof window.requestIdleCallback === 'function';
    const onOpen = () => { setOpenFirst(true); setReady(true); };
    window.addEventListener('vk-a11y-open', onOpen);
    const idle = hasIdle ? window.requestIdleCallback(() => setReady(true), { timeout: 2500 }) : window.setTimeout(() => setReady(true), 1500);
    return () => {
      window.removeEventListener('vk-a11y-open', onOpen);
      if (hasIdle) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
    };
  }, []);
  if (!ready) return null;
  return (
    <Suspense fallback={null}>
      <Center openOnMount={openFirst} />
    </Suspense>
  );
}
