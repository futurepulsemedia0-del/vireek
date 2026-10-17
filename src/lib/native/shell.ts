// src/lib/native/shell.ts — splash screen + status bar for the installed app (no-ops on the web).

import { isNative } from './platform';

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
      .then(({ StatusBar, Style }) => StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }))
      .catch(() => undefined);
  };
  apply();
  const observer = new MutationObserver(apply);
  observer.observe(root, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}
