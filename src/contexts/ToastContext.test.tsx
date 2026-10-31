import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { reactI18nextMock } from '@/test/i18nMock';

vi.mock('react-i18next', () => reactI18nextMock);
const announce = vi.fn();
vi.mock('@/lib/a11y/announcer', () => ({ announce: (...a: unknown[]) => announce(...a) }));
vi.mock('@/lib/native/haptics', () => ({ haptic: vi.fn() }));
// Exit animations are timer/rAF driven; unit tests use a passthrough and Playwright covers the motion.
vi.mock('framer-motion', async () => {
  const React = await import('react');
  const strip = ({ layout: _l, initial: _i, animate: _a, exit: _e, transition: _t, ...rest }: Record<string, unknown>) => rest;
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    motion: { div: React.forwardRef<HTMLDivElement, Record<string, unknown>>((props, ref) => React.createElement('div', { ref, ...strip(props) })) },
    useReducedMotion: () => true,
  };
});

import { ToastProvider, useToast } from './ToastContext';

let api: ReturnType<typeof useToast>;
function Probe() {
  api = useToast();
  return null;
}
const mount = () =>
  render(
    <ToastProvider>
      <Probe />
    </ToastProvider>,
  );

beforeEach(() => {
  vi.useFakeTimers();
  announce.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ToastProvider', () => {
  it('keeps the legacy signature toast(message, type) working and returns an id', () => {
    mount();
    let id = '';
    act(() => void (id = api.toast('Saved', 'success')));
    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(id).toMatch(/^toast-/);
  });

  it('success auto-dismisses after its duration', () => {
    mount();
    act(() => void api.toast('Saved', 'success'));
    act(() => void vi.advanceTimersByTime(4100));
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('announces polite for success/info and assertive for error/warning (container itself is not a live region)', () => {
    mount();
    act(() => {
      api.toast('ok', 'success');
      api.toast('bad', 'error');
      api.toast('careful', 'warning');
    });
    expect(announce).toHaveBeenCalledWith('ok', 'polite');
    expect(announce).toHaveBeenCalledWith('bad', 'assertive');
    expect(announce).toHaveBeenCalledWith('careful', 'assertive');
    expect(screen.getByRole('region', { name: 'Notifications' })).not.toHaveAttribute('aria-live');
  });

  it('dedupes: one card, ×N badge, and announced only once', () => {
    mount();
    act(() => {
      api.toast('Same', 'info');
      api.toast('Same', 'info');
      api.toast('Same', 'info');
    });
    expect(screen.getAllByText('Same')).toHaveLength(1);
    expect(screen.getByText('×3')).toBeInTheDocument();
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('pauses auto-dismiss while hovered and resumes afterwards', () => {
    mount();
    act(() => void api.toast('Hold on', 'success')); // 4000ms
    const card = screen.getByText('Hold on').closest('[data-toast-type]') as HTMLElement;
    act(() => void vi.advanceTimersByTime(3000));
    fireEvent.pointerEnter(card);
    act(() => void vi.advanceTimersByTime(60000));
    expect(screen.getByText('Hold on')).toBeInTheDocument();
    fireEvent.pointerLeave(card);
    act(() => void vi.advanceTimersByTime(900));
    expect(screen.getByText('Hold on')).toBeInTheDocument(); // ~1000ms left
    act(() => void vi.advanceTimersByTime(200));
    expect(screen.queryByText('Hold on')).toBeNull();
  });

  it('error with an action is sticky; the action runs and dismisses', () => {
    mount();
    const retry = vi.fn();
    act(() => void api.toast('Failed', 'error', { action: { label: 'Retry', onClick: retry } }));
    act(() => void vi.advanceTimersByTime(60000));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.queryByText('Failed')).toBeNull();
  });

  it('queues beyond 3 and shows the next one when a slot frees up', () => {
    mount();
    act(() => {
      for (let i = 0; i < 5; i++) api.toast(`n${i}`, 'info', { sticky: true });
    });
    expect(screen.queryByText('n3')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0]);
    expect(screen.getByText('n3')).toBeInTheDocument();
  });

  it('Escape on a focused toast dismisses it; the dismiss button is labelled', () => {
    mount();
    act(() => void api.toast('Bye', 'info', { sticky: true }));
    const card = screen.getByText('Bye').closest('[data-toast-type]') as HTMLElement;
    fireEvent.keyDown(card, { key: 'Escape' });
    expect(screen.queryByText('Bye')).toBeNull();
  });

  it('the context value is stable across toasts: consumers do not re-render when toasts change', () => {
    let renders = 0;
    function Spy() {
      useToast();
      renders++;
      return null;
    }
    render(
      <ToastProvider>
        <Probe />
        <Spy />
      </ToastProvider>,
    );
    const before = renders;
    act(() => void api.toast('a', 'info'));
    act(() => void api.toast('b', 'success'));
    expect(renders).toBe(before);
  });
});
