import { useEffect } from 'react';
import { dismissBootLoader, initLoadingRuntime } from './runtime';

/**
 * Mount once, high in the tree (src/main.tsx). When React has committed its first frame it
 * removes the static boot loader from index.html and starts the background-tab animation pause.
 * Renders nothing.
 */
export function BootDismiss() {
  useEffect(() => {
    const cleanup = initLoadingRuntime();
    // Two frames: the app's first paint is on screen before the loader fades, so there is no white flash.
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(dismissBootLoader);
    });
    return () => {
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
      cleanup();
    };
  }, []);
  return null;
}
