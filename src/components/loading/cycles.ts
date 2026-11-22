/**
 * Length of ONE full loop of each brand loader, in ms.
 * Must match brand-loader.css and index.html (guarded by cycles.test.ts).
 * Lower a value here to shorten the guaranteed minimum display time.
 */
export const LOADER_CYCLE_MS = {
  thread: 3400,
  fill: 2200,
  signal: 2400,
  network: 3800,
  pulse: 1900,
} as const;

/** One full loop of the launch splash in index.html (`animation: vb-m 2.4s`). */
export const BOOT_CYCLE_MS = 2400;

/** Lazy route chunks show the `pulse` loader (RouteFallback variant="app"). */
export const ROUTE_MIN_CYCLE_MS = LOADER_CYCLE_MS.pulse;
