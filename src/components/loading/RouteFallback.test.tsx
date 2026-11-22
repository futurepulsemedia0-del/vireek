import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { RouteFallback } from '@/components/loading/RouteFallback';

const tick = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });

describe('RouteFallback', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows nothing for the first 250ms, then the top bar, then the mark at 800ms', async () => {
    const { container } = render(<RouteFallback variant="app" />);
    await tick(249);
    expect(container.querySelector('.vrk-topbar')).toBeNull();
    expect(container.querySelector('svg')).toBeNull();
    await tick(1);
    expect(container.querySelector('.vrk-topbar')).not.toBeNull();
    expect(container.querySelector('.vrk-v')).toBeNull();
    await tick(550);
    expect(container.querySelector('.vrk-v')).not.toBeNull();
  });

  it('picks the loader variant by route kind: marketing → signal, app/portal → pulse, data → network', async () => {
    const expected = { marketing: 'vrk-v--signal', app: 'vrk-v--pulse', portal: 'vrk-v--pulse', data: 'vrk-v--network' } as const;
    for (const [variant, cls] of Object.entries(expected)) {
      const { container, unmount } = render(<RouteFallback variant={variant as keyof typeof expected} />);
      await tick(800);
      expect(container.querySelector('svg.vrk-v')).toHaveClass(cls);
      unmount();
    }
  });

  it('is a fixed stage that fills the visible area, whatever props the call site passes', () => {
    for (const props of [{}, { fullScreen: true }, { immediate: true }]) {
      const { container, unmount } = render(<RouteFallback {...props} />);
      const stage = container.firstElementChild as HTMLElement;
      expect(stage).toHaveAttribute('data-loader-stage', 'viewport');
      expect(stage).toHaveClass('fixed', 'inset-0', 'items-center', 'justify-center');
      expect(stage).not.toHaveClass('min-h-screen');
      expect(stage).not.toHaveClass('min-h-[60vh]');
      unmount();
    }
  });

  it('renders the mark large (xxl = 144px) and keeps the microcopy out of the flow so the mark never moves', async () => {
    const { container } = render(<RouteFallback variant="app" immediate />);
    await tick(1);
    const svg = container.querySelector('svg.vrk-v')!;
    expect(svg.getAttribute('height')).toBe('144');
    const markBox = svg.parentElement!.parentElement!;
    expect(markBox).toHaveClass('h-36');
    await tick(2600);
    const copy = container.querySelector('p')!;
    expect(copy).toHaveClass('absolute', 'top-full');
    expect(markBox.contains(copy)).toBe(true);
  });

  it('keeps one polite status region for assistive tech', async () => {
    const { container } = render(<RouteFallback variant="data" />);
    await tick(800);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
  });
});
