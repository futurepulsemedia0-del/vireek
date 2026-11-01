export const SW_UPDATE_EVENT = 'vireek:sw-update';

let userRequestedUpdate = false;

/** Registers /sw.js and announces waiting updates; the new worker only activates when the user accepts. */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  const hadController = Boolean(navigator.serviceWorker.controller);

  const announce = (worker: ServiceWorker) =>
    window.dispatchEvent(new CustomEvent<ServiceWorker>(SW_UPDATE_EVENT, { detail: worker }));

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        if (reg.waiting && navigator.serviceWorker.controller) announce(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const worker = reg.installing;
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) announce(worker);
          });
        });
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') void reg.update().catch(() => undefined);
        });
      })
      .catch(() => undefined); // Non-fatal: push and offline shell just are not available this session.
  });

  // Reload only when THIS tab asked for the update; never on first install, never mid-work.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && userRequestedUpdate) window.location.reload();
  });
}

export function applyServiceWorkerUpdate(worker: ServiceWorker): void {
  userRequestedUpdate = true;
  worker.postMessage({ type: 'SKIP_WAITING' });
}
