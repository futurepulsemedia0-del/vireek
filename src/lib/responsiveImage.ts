export const IMAGE_SIZES = '(min-width: 1024px) 1100px, 100vw';

/** "/img/hero-480.avif 480w, /img/hero-800.avif 800w, ..." */
export function imageSrcSet(name: string, widths: readonly number[], ext: 'avif' | 'webp'): string {
  return widths.map((w) => `/img/${name}-${w}.${ext} ${w}w`).join(', ');
}
