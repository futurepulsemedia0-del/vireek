import { lazy, type ComponentType } from 'react';

function BrokenPage() {
  return (
    <div role="alert" className="mx-auto max-w-md p-8 text-center">
      <p className="text-base font-semibold text-text-primary">This page could not be loaded.</p>
      <p className="mt-2 text-sm text-text-secondary">Please reload. If it keeps happening, contact support.</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="focus-ring mt-4 rounded-xl border border-border px-4 py-2 text-sm font-medium text-text-primary hover:bg-bg-tertiary"
      >
        Reload
      </button>
    </div>
  );
}

/**
 * Drop-in replacement for React.lazy. If a module has no usable default
 * export (the cause of React error #130), it renders a recoverable message
 * instead of crashing the whole app, and logs WHICH loader is broken.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function safeLazy<T extends ComponentType<any>>(factory: () => Promise<{ default: T }>) {
  return lazy(async () => {
    const mod = await factory();
    if (mod && (mod as { default?: unknown }).default != null) return mod;
    // eslint-disable-next-line no-console
    console.error('[safeLazy] module has no default export. Loader:', String(factory));
    return { default: BrokenPage as unknown as T };
  });
}
