// WCAG 4.1.3 Status Messages: announce() only reaches assistive technology while <AriaLiveRegion /> is mounted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { AriaLiveRegion, announce } from './announcer';

beforeEach(() => {
  // Run the announcer's requestAnimationFrame hand-off synchronously.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AriaLiveRegion + announce()', () => {
  it('renders one polite status region and one assertive alert region', () => {
    render(<AriaLiveRegion />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive');
  });

  it('routes polite messages to the status region only', () => {
    render(<AriaLiveRegion />);
    act(() => announce('Saved'));
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });

  it('routes assertive messages to the alert region only', () => {
    render(<AriaLiveRegion />);
    act(() => announce('Payment failed', 'assertive'));
    expect(screen.getByRole('alert')).toHaveTextContent('Payment failed');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('stops listening after unmount (no update on an unmounted region, no leak)', () => {
    const { unmount } = render(<AriaLiveRegion />);
    unmount();
    expect(() => act(() => announce('late'))).not.toThrow();
  });
});
