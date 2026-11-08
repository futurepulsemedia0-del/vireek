import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const FLASH_CLASS = 'settings-deeplink-flash';

/**
 * Scrolls to #id, focuses the control and flashes it briefly. Reduced motion: no smooth
 * scroll and no flash animation (the focus ring alone marks the target). Unknown ids do nothing.
 * Add `.settings-deeplink-flash { outline: 2px solid rgb(var(--accent-primary)); outline-offset: 2px; }`
 * in the settings stylesheet; this hook only toggles the class.
 */
export function useSettingDeepLink(ready = true): void {
  const { hash } = useLocation();
  useEffect(() => {
    if (!ready || !hash || hash.length < 2) return;
    const id = decodeURIComponent(hash.slice(1));
    const el = document.getElementById(id);
    if (!el) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
    const focusable = el.matches('input,select,textarea,button,[tabindex]')
      ? el
      : el.querySelector<HTMLElement>('input,select,textarea,button,[tabindex]');
    (focusable ?? el).focus({ preventScroll: true });
    el.classList.add(FLASH_CLASS);
    const timer = window.setTimeout(() => el.classList.remove(FLASH_CLASS), reduced ? 0 : 1800);
    return () => window.clearTimeout(timer);
  }, [hash, ready]);
}
