import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useCalendarPrefs, useCalendarShortcuts } from './useCalendarView';
import { CALENDAR_PREFS_KEY } from '@/lib/calendarViews';

beforeEach(() => {
  window.localStorage.clear();
});

describe('useCalendarPrefs', () => {
  it('starts on the existing default (week / status)', () => {
    const { result } = renderHook(() => useCalendarPrefs());
    expect(result.current.view).toBe('week');
    expect(result.current.colorMode).toBe('status');
    expect(result.current.agendaGroupBy).toBe('date');
  });

  it('restores saved preferences', () => {
    window.localStorage.setItem(CALENDAR_PREFS_KEY, JSON.stringify({ view: 'agenda', colorMode: 'trade', agendaGroupBy: 'technician' }));
    const { result } = renderHook(() => useCalendarPrefs());
    expect(result.current.view).toBe('agenda');
    expect(result.current.colorMode).toBe('trade');
    expect(result.current.agendaGroupBy).toBe('technician');
  });

  it('ignores corrupt storage', () => {
    window.localStorage.setItem(CALENDAR_PREFS_KEY, '{oops');
    const { result } = renderHook(() => useCalendarPrefs());
    expect(result.current.view).toBe('week');
  });

  it('persists changes', () => {
    const { result } = renderHook(() => useCalendarPrefs());
    act(() => result.current.setView('month'));
    act(() => result.current.setColorMode('technician'));
    expect(result.current.view).toBe('month');
    const saved = JSON.parse(window.localStorage.getItem(CALENDAR_PREFS_KEY) ?? '{}');
    expect(saved.view).toBe('month');
    expect(saved.colorMode).toBe('technician');
  });

  it('keeps working when storage throws', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useCalendarPrefs());
    act(() => result.current.setView('agenda'));
    expect(result.current.view).toBe('agenda');
    getItem.mockRestore();
    setItem.mockRestore();
  });
});

describe('useCalendarShortcuts', () => {
  function setup(enabled = true) {
    const handlers = { onView: vi.fn(), onPrev: vi.fn(), onNext: vi.fn(), onToday: vi.fn() };
    renderHook(() => useCalendarShortcuts({ enabled, ...handlers }));
    return handlers;
  }
  const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = window) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));

  it('maps letters to views, J/K to next/previous and T to today', () => {
    const h = setup();
    press('m');
    press('A');
    press('r');
    press('j');
    press('k');
    press('t');
    expect(h.onView.mock.calls).toEqual([['month'], ['agenda'], ['resources']]);
    expect(h.onNext).toHaveBeenCalledTimes(1);
    expect(h.onPrev).toHaveBeenCalledTimes(1);
    expect(h.onToday).toHaveBeenCalledTimes(1);
  });

  it('ignores unrelated keys and modified keys', () => {
    const h = setup();
    press('x');
    press('m', { ctrlKey: true });
    press('m', { metaKey: true });
    press('m', { altKey: true });
    expect(h.onView).not.toHaveBeenCalled();
  });

  it('ignores keys typed into form fields', () => {
    const h = setup();
    const input = document.createElement('input');
    document.body.appendChild(input);
    press('m', {}, input);
    input.remove();
    expect(h.onView).not.toHaveBeenCalled();
  });

  it('leaves the second key of a global "g then …" sequence alone', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 14, 12, 0, 0));
    const h = setup();
    press('g');
    vi.setSystemTime(new Date(2026, 9, 14, 12, 0, 0, 300));
    press('r'); // "g r" = Go to Reviews, not Resources view
    expect(h.onView).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(2026, 9, 14, 12, 0, 2));
    press('r');
    expect(h.onView).toHaveBeenCalledWith('resources');
    vi.useRealTimers();
  });

  it('does nothing while disabled', () => {
    const h = setup(false);
    press('m');
    expect(h.onView).not.toHaveBeenCalled();
  });
});
