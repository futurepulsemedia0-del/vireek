const HREF = 'https://fonts.googleapis.com/css2?family=Dancing+Script&family=Caveat&family=Great+Vibes&display=swap';
let loaded = false;

/** Handwriting fonts are only needed on signature/handwriting screens: load them on demand, not for every visitor. */
export function loadSignatureFonts(): void {
  if (loaded || typeof document === 'undefined') return;
  loaded = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = HREF;
  document.head.appendChild(link);
}
