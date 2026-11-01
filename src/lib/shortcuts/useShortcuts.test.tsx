import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { __resetShortcutBusForTests, useShortcutContext, useShortcutHandlers } from './useShortcuts';
import { shortcutStore } from './store';

interface Props {
  onCalendar?: () => void;
  onHelp?: () => void;
  onToggle?: () => void;
  dashboard?: boolean;
}

function Harness({ onCalendar = () => undefined, onHelp = () => undefined, onToggle = () => undefined, dashboard = true }: Props) {
  useShortcutContext('dashboard', dashboard);
  useShortcutHandlers({ 'nav.calendar': onCalendar, 'help.shortcuts': onHelp, 'palette.toggle': onToggle });
  return <input aria-label="field" />;
}

const key = (target: EventTarget, init: KeyboardEventInit) => fireEvent.keyDown(target, init);

describe('global shortcut dispatcher', () => {
  beforeEach(() => {
    window.localStorage.clear();
    shortcutStore.setScope('hook-test');
    shortcutStore.resetAll();
  });
  afterEach(() => {
    __resetShortcutBusForTests();
  });

  it('runs a sequence handler ("g" then "c")', () => {
    const onCalendar = vi.fn();
    render(<Harness onCalendar={onCalendar} />);
    key(document, { key: 'g' });
    key(document, { key: 'c' });
    expect(onCalendar).toHaveBeenCalledTimes(1);
  });

  it('opens the cheat sheet with "?" (Shift held, as on a US keyboard)', () => {
    const onHelp = vi.fn();
    render(<Harness onHelp={onHelp} />);
    key(document, { key: '?', shiftKey: true });
    expect(onHelp).toHaveBeenCalledTimes(1);
  });

  it('never fires inside an input, except an allowed mod chord', () => {
    const onCalendar = vi.fn();
    const onHelp = vi.fn();
    const onToggle = vi.fn();
    const { getByLabelText } = render(<Harness onCalendar={onCalendar} onHelp={onHelp} onToggle={onToggle} />);
    const field = getByLabelText('field');
    key(field, { key: 'g' });
    key(field, { key: 'c' });
    key(field, { key: '?', shiftKey: true });
    expect(onCalendar).not.toHaveBeenCalled();
    expect(onHelp).not.toHaveBeenCalled();
    key(field, { key: 'k', ctrlKey: true });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('does not fire dashboard shortcuts outside the dashboard context', () => {
    const onCalendar = vi.fn();
    render(<Harness onCalendar={onCalendar} dashboard={false} />);
    key(document, { key: 'g' });
    key(document, { key: 'c' });
    expect(onCalendar).not.toHaveBeenCalled();
  });

  it('is blocked while a modal dialog is open, but the palette toggle still works', () => {
    const onCalendar = vi.fn();
    const onToggle = vi.fn();
    render(
      <>
        <Harness onCalendar={onCalendar} onToggle={onToggle} />
        <div role="dialog" aria-modal="true" />
      </>,
    );
    key(document, { key: 'g' });
    key(document, { key: 'c' });
    expect(onCalendar).not.toHaveBeenCalled();
    key(document, { key: 'k', ctrlKey: true });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('lets the most recently mounted handler win and restores the previous one on unmount', () => {
    const first = vi.fn();
    const second = vi.fn();
    render(<Harness onCalendar={first} />);
    const later = render(<Harness onCalendar={second} />);
    key(document, { key: 'g' });
    key(document, { key: 'c' });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    later.unmount();
    key(document, { key: 'g' });
    key(document, { key: 'c' });
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('stops listening after unmount', () => {
    const onCalendar = vi.fn();
    const { unmount } = render(<Harness onCalendar={onCalendar} />);
    unmount();
    key(document, { key: 'g' });
    key(document, { key: 'c' });
    expect(onCalendar).not.toHaveBeenCalled();
  });

  it('follows the user\'s customised binding immediately', () => {
    const onCalendar = vi.fn();
    render(<Harness onCalendar={onCalendar} />);
    shortcutStore.setOverride('nav.calendar', 'g x');
    key(document, { key: 'g' });
    key(document, { key: 'c' });
    expect(onCalendar).not.toHaveBeenCalled();
    key(document, { key: 'g' });
    key(document, { key: 'x' });
    expect(onCalendar).toHaveBeenCalledTimes(1);
  });

  it('a shortcut the user turned off never fires', () => {
    const onCalendar = vi.fn();
    render(<Harness onCalendar={onCalendar} />);
    shortcutStore.setOverride('nav.calendar', null);
    key(document, { key: 'g' });
    key(document, { key: 'c' });
    expect(onCalendar).not.toHaveBeenCalled();
  });

  it('ignores IME composition', () => {
    const onHelp = vi.fn();
    render(<Harness onHelp={onHelp} />);
    key(document, { key: '?', shiftKey: true, isComposing: true });
    expect(onHelp).not.toHaveBeenCalled();
  });
});
