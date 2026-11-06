const FILES = [
  { family: 'Dancing Script', url: '/fonts/dancing-script-latin-400-normal.woff2' },
  { family: 'Caveat', url: '/fonts/caveat-latin-400-normal.woff2' },
  { family: 'Great Vibes', url: '/fonts/great-vibes-latin-400-normal.woff2' },
] as const;
let pending: Promise<void> | null = null;

/**
 * Handwriting fonts are only needed on signature screens: load them on demand from our own origin.
 * Never rejects: on failure the `cursive` fallback stays and a later call retries.
 */
export function loadSignatureFonts(): Promise<void> {
  if (pending) return pending;
  if (typeof document === 'undefined' || typeof FontFace === 'undefined' || !document.fonts) {
    return Promise.resolve();
  }
  let failed = false;
  pending = Promise.all(
    FILES.map(async ({ family, url }) => {
      try {
        const face = new FontFace(family, `url(${url}) format('woff2')`, { weight: '400', style: 'normal', display: 'swap' });
        document.fonts.add(await face.load());
      } catch {
        failed = true;
      }
    }),
  ).then(() => {
    if (failed) pending = null;
  });
  return pending;
}
