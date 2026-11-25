import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BLANK_POLLS, POLL_MS, STUCK_BOOT_MS, installBootWatchdog, isRootBlank } from './bootWatchdog';

const panel = () => document.getElementById('vrk-recovery');

function mountDom({ boot, rootChild }: { boot: boolean; rootChild: boolean }) {
  document.body.innerHTML = '';
  if (boot) {
    const b = document.createElement('div');
    b.id = 'vrk-boot';
    document.body.appendChild(b);
  }
  const root = document.createElement('div');
  root.id = 'root';
  if (rootChild) root.appendChild(document.createElement('main'));
  document.body.appendChild(root);
  return root;
}

describe('bootWatchdog', () => {
  let stop: () => void;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    stop?.();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('isRootBlank: missing or childless root is blank', () => {
    expect(isRootBlank(null)).toBe(true);
    expect(isRootBlank(mountDom({ boot: false, rootChild: false }))).toBe(true);
    expect(isRootBlank(mountDom({ boot: false, rootChild: true }))).toBe(false);
  });

  it('healthy app: no panel, ever', () => {
    mountDom({ boot: false, rootChild: true });
    stop = installBootWatchdog();
    vi.advanceTimersByTime(STUCK_BOOT_MS + 5_000);
    expect(panel()).toBeNull();
  });

  it('blank root after the boot loader is gone → recovery panel with a Reload button after 3 polls', () => {
    mountDom({ boot: false, rootChild: false });
    stop = installBootWatchdog();
    vi.advanceTimersByTime(POLL_MS * (BLANK_POLLS - 1));
    expect(panel()).toBeNull();
    vi.advanceTimersByTime(POLL_MS);
    expect(panel()).not.toBeNull();
    expect(panel()!.getAttribute('role')).toBe('alert');
    expect(panel()!.querySelector('button')!.textContent).toBe('Reload');
  });

  it('boot loader still there after 15s → recovery panel; it leaves again once the app is alive', () => {
    const root = mountDom({ boot: true, rootChild: false });
    stop = installBootWatchdog();
    vi.advanceTimersByTime(STUCK_BOOT_MS - 1);
    expect(panel()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(panel()).not.toBeNull();
    document.getElementById('vrk-boot')!.remove();
    root.appendChild(document.createElement('main'));
    vi.advanceTimersByTime(POLL_MS);
    expect(panel()).toBeNull();
  });

  it('never stacks two panels', () => {
    mountDom({ boot: false, rootChild: false });
    stop = installBootWatchdog();
    vi.advanceTimersByTime(POLL_MS * 10);
    expect(document.querySelectorAll('#vrk-recovery')).toHaveLength(1);
  });

  it('cleanup stops the timers', () => {
    mountDom({ boot: false, rootChild: false });
    stop = installBootWatchdog();
    stop();
    vi.advanceTimersByTime(POLL_MS * 10);
    expect(panel()).toBeNull();
  });
});
