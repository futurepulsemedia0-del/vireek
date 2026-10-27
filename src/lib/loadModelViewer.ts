/**
 * Lazy-loads Google's <model-viewer> web component (registers the custom
 * element as a side effect). Kept in its own module so:
 *  - the ~700 KB 3D engine is only downloaded when a customer or technician
 *    actually opens a preview (never on the normal quote page load), and
 *  - tests can mock this one file instead of the package.
 */

let pending: Promise<void> | null = null;

export function loadModelViewer(): Promise<void> {
  if (!pending) {
    pending = import('@google/model-viewer')
      .then(() => undefined)
      .catch((error: unknown) => {
        pending = null; // allow a retry after a network failure
        throw error;
      });
  }
  return pending;
}
