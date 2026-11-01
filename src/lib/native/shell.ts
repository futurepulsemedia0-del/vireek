// src/lib/native/shell.ts — splash screen + status bar for the installed app (no-ops on the web).

import { isNative } from './platform';
import { THEME_COLOR } from '@/styles/tokens.generated';

let splashHidden = false;

/** Hides the launch splash after the first paint; a timer guarantees it can never get stuck. */
export function hideNativeSplash(): void {
  if (!isNative() || splashHidden) return;
  const hide = () => {
    if (splashHidden) return;
    splashHidden = true;
    void import('@capacitor/splash-screen').then(({ SplashScreen }) => SplashScreen.hide({ fadeOutDuration: 200 })).catch(() => undefined);
  };
  window.requestAnimationFrame(() => window.requestAnimationFrame(hide));
  window.setTimeout(hide, 4000);
}

/** Keeps the status-bar icons readable when the app theme flips (html.dark). Returns a cleanup. */
export function syncStatusBarWithTheme(): () => void {
  if (!isNative()) return () => undefined;
  const root = document.documentElement;
  const apply = () => {
    const dark = root.classList.contains('dark');
    void import('@capacitor/status-bar')
      .then(async ({ StatusBar, Style }) => {
        await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light });
        // Android only (iOS ignores it): status bar = the page's top surface for the active theme.
        await StatusBar.setBackgroundColor({ color: dark ? THEME_COLOR.dark : THEME_COLOR.light }).catch(() => undefined);
      })
      .catch(() => undefined);
  };
  apply();
  const observer = new MutationObserver(apply);
  observer.observe(root, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}
