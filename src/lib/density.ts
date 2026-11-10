/**
 * Display density. "compact" tightens SPACING only (row padding, gaps — the --density-* variables consumed by the
 * `py-row`, `gap-dense` and `min-h-target` Tailwind spacing tokens). It NEVER changes a type token: text stays at or
 * above 0.75rem (12px) in every density, and interactive targets never drop below 2rem (>= WCAG 2.2 SC 2.5.8's 24px).
 * Wired through tailwind.config.js (plugin base layer: `:root[data-density="compact"]`).
 */
export type Density = 'comfortable' | 'compact';

export const DENSITY_STORAGE_KEY = 'vireek.density';
export const DENSITIES: readonly Density[] = ['comfortable', 'compact'];

export function isDensity(value: unknown): value is Density {
  return value === 'comfortable' || value === 'compact';
}

export function readDensity(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Density {
  try {
    const v = storage?.getItem(DENSITY_STORAGE_KEY);
    return isDensity(v) ? v : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

/** Sets/removes the data-density attribute on <html>. `comfortable` is the absence of the attribute. */
export function applyDensity(density: Density, root: HTMLElement = document.documentElement): void {
  if (density === 'compact') root.setAttribute('data-density', 'compact');
  else root.removeAttribute('data-density');
}

export function setDensity(density: Density, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  applyDensity(density);
  try {
    storage?.setItem(DENSITY_STORAGE_KEY, density);
  } catch {
    /* private mode / quota: the attribute is still applied for this session */
  }
}

/** Call once at startup, before first render. */
export function initDensity(): Density {
  const d = readDensity();
  applyDensity(d);
  return d;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
