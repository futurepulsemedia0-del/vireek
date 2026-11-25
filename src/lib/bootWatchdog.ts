// src/lib/bootWatchdog.ts
// Safety net for the launch window. Two failures used to look identical to the user, "a blank page, nothing else":
//   stuck: the boot loader (#vrk-boot, index.html) is still on screen long after start, so the app never finished mounting
//   blank: the boot loader is gone but #root is empty (React unmounted, or nothing rendered)
// In both cases a small recovery panel with a Reload button is shown. It removes itself if the app comes alive later.
// Plain DOM + CSSOM styles on purpose: no React, no i18n, no inline <style>/<script>, so it works when the app itself is broken
// and does not need any CSP change.

const BOOT_ID = 'vrk-boot';
const ROOT_ID = 'root';
const PANEL_ID = 'vrk-recovery';

export const STUCK_BOOT_MS = 15_000;
export const POLL_MS = 1_000;
export const BLANK_POLLS = 3;
export const WATCH_FOR_MS = 60_000;

export type RecoveryReason = 'stuck' | 'blank';

export function isRootBlank(root: Element | null): boolean {
  return !root || root.childElementCount === 0;
}

const COPY: Record<RecoveryReason, { title: string; body: string }> = {
  stuck: { title: 'Vireek is taking longer than usual', body: 'Check your connection, then reload. If it keeps happening, restart the app.' },
  blank: { title: 'Vireek did not load', body: 'Something stopped the app from starting. Reload to try again.' },
};

export function showRecoveryPanel(reason: RecoveryReason): void {
  if (typeof document === 'undefined' || document.getElementById(PANEL_ID)) return;
  const html = document.documentElement;
  const dark = html.classList.contains('dark') || html.classList.contains('vrk-native');
  const bg = dark ? '#141413' : '#FAF9F5';
  const ink = dark ? '#FAF9F5' : '#141413';

  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.setAttribute('role', 'alert');
  Object.assign(panel.style, {
    position: 'fixed',
    top: '0',
    right: '0',
    bottom: '0',
    left: '0',
    zIndex: '2147483647',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '14px',
    padding: 'calc(24px + env(safe-area-inset-top, 0px)) 24px calc(24px + env(safe-area-inset-bottom, 0px))',
    textAlign: 'center',
    background: bg,
    color: ink,
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  });

  const brand = document.createElement('div');
  brand.textContent = 'Vireek';
  Object.assign(brand.style, { fontSize: '22px', fontWeight: '700', letterSpacing: '-0.03em' });

  const title = document.createElement('div');
  title.textContent = COPY[reason].title;
  Object.assign(title.style, { fontSize: '18px', fontWeight: '600' });

  const body = document.createElement('div');
  body.textContent = COPY[reason].body;
  Object.assign(body.style, { fontSize: '14px', opacity: '0.75', maxWidth: '320px', lineHeight: '1.5' });

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Reload';
  Object.assign(button.style, {
    minHeight: '48px',
    minWidth: '160px',
    padding: '0 24px',
    border: '0',
    borderRadius: '12px',
    background: ink,
    color: bg,
    fontSize: '16px',
    fontWeight: '600',
    cursor: 'pointer',
  });
  button.addEventListener('click', () => window.location.reload());

  panel.append(brand, title, body, button);
  document.body.appendChild(panel);
}

/** Call once at boot (src/main.tsx). Returns a cleanup function. */
export function installBootWatchdog(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined;
  const startedAt = Date.now();
  let blankPolls = 0;

  const stuckTimer = window.setTimeout(() => {
    if (document.getElementById(BOOT_ID)) showRecoveryPanel('stuck');
  }, STUCK_BOOT_MS);

  const poll = window.setInterval(() => {
    if (Date.now() - startedAt > WATCH_FOR_MS) {
      stop();
      return;
    }
    const booting = Boolean(document.getElementById(BOOT_ID));
    const blank = isRootBlank(document.getElementById(ROOT_ID));
    const panel = document.getElementById(PANEL_ID);

    if (!booting && !blank) {
      blankPolls = 0;
      panel?.remove(); // the app came alive after all (slow device): get out of the way
      return;
    }
    if (!booting && blank) {
      blankPolls += 1;
      if (blankPolls >= BLANK_POLLS) showRecoveryPanel('blank');
    } else {
      blankPolls = 0;
    }
  }, POLL_MS);

  function stop(): void {
    window.clearTimeout(stuckTimer);
    window.clearInterval(poll);
  }
  return stop;
}
