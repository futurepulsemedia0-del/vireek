import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { Tooltip } from './Tooltip';


function firePointer(el: Element, type: 'pointerEnter' | 'pointerLeave' | 'pointerDown', pointerType: 'mouse' | 'touch') {
  // React derives onPointerEnter/Leave from pointerover/pointerout.
  const ev = type === 'pointerEnter' ? createEvent.pointerOver(el) : type === 'pointerLeave' ? createEvent.pointerOut(el) : createEvent.pointerDown(el);
  Object.defineProperty(ev, 'pointerType', { value: pointerType });
  fireEvent(el, ev);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const bubble = () => document.body.querySelector<HTMLElement>('div[aria-hidden="true"].fixed, div[aria-hidden="true"][style*="fixed"]');

function setup(props: Partial<React.ComponentProps<typeof Tooltip>> = {}) {
  render(
    <Tooltip content="Helpful hint" {...props}>
      <button type="button">Trigger</button>
    </Tooltip>,
  );
  return screen.getByRole('button', { name: 'Trigger' });
}

describe('Tooltip', () => {
  it('always exposes the content to assistive tech via aria-describedby', () => {
    const btn = setup();
    expect(btn).toHaveAccessibleDescription('Helpful hint');
  });

  it('opens after the delay on mouse hover and closes on leave', () => {
    const btn = setup({ delayMs: 500 });
    firePointer(btn, 'pointerEnter', 'mouse');
    expect(bubble()).toBeNull();
    act(() => void vi.advanceTimersByTime(499));
    expect(bubble()).toBeNull();
    act(() => void vi.advanceTimersByTime(2));
    expect(bubble()).not.toBeNull();
    firePointer(btn, 'pointerLeave', 'mouse');
    act(() => void vi.advanceTimersByTime(150));
    expect(bubble()).toBeNull();
  });

  it('does not open on touch hover emulation', () => {
    const btn = setup({ delayMs: 0 });
    firePointer(btn, 'pointerEnter', 'touch');
    act(() => void vi.advanceTimersByTime(1000));
    expect(bubble()).toBeNull();
  });

  it('opens immediately on keyboard focus-visible and closes on blur', () => {
    const btn = setup();
    act(() => btn.focus());
    act(() => void vi.advanceTimersByTime(1));
    expect(bubble()).not.toBeNull();
    act(() => btn.blur());
    expect(bubble()).toBeNull();
  });

  it('Escape dismisses it and the keydown does not reach other handlers', () => {
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    const btn = setup();
    act(() => btn.focus());
    act(() => void vi.advanceTimersByTime(1));
    expect(bubble()).not.toBeNull();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(bubble()).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    expect(btn).toHaveFocus();
    document.removeEventListener('keydown', outer);
  });

  it('touch: openOnTap toggles and auto-closes', () => {
    const btn = setup({ openOnTap: true });
    firePointer(btn, 'pointerDown', 'touch');
    act(() => void vi.advanceTimersByTime(1));
    expect(bubble()).not.toBeNull();
    act(() => void vi.advanceTimersByTime(4100));
    expect(bubble()).toBeNull();
  });

  it('stays open while the pointer is over the bubble (hoverable)', () => {
    const btn = setup({ delayMs: 0 });
    firePointer(btn, 'pointerEnter', 'mouse');
    act(() => void vi.advanceTimersByTime(1));
    firePointer(btn, 'pointerLeave', 'mouse');
    firePointer(bubble() as HTMLElement, 'pointerEnter', 'mouse');
    act(() => void vi.advanceTimersByTime(500));
    expect(bubble()).not.toBeNull();
  });

  it('merges with an existing aria-describedby', () => {
    render(
      <Tooltip content="Tip">
        <button type="button" aria-describedby="other">T</button>
      </Tooltip>,
    );
    expect(screen.getByRole('button').getAttribute('aria-describedby')).toMatch(/^other .+/);
  });

  it('renders just the child when content is empty', () => {
    render(
      <Tooltip content="">
        <button type="button">Plain</button>
      </Tooltip>,
    );
    expect(screen.getByRole('button', { name: 'Plain' })).not.toHaveAttribute('aria-describedby');
  });
});
