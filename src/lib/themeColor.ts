// Keeps <meta name="theme-color"> (browser chrome / PWA title bar) equal to the page's top surface for the ACTIVE theme.
// Values come from the generated token file, so they can never drift from the CSS tokens.
import { THEME_COLOR } from '@/styles/tokens.generated';

export function applyThemeColor(theme: 'light' | 'dark'): void {
  if (typeof document === 'undefined') return;
  try {
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    meta.content = THEME_COLOR[theme];
    // Drop any media-conditioned variants: they would fight a manual light/dark override.
    document.querySelectorAll('meta[name="theme-color"][media]').forEach((m) => m.remove());
  } catch {
    /* non-critical */
  }
}
