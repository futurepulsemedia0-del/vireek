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

  it('fullScreen fills the viewport (auth guards); default keeps the 60vh block', () => {
    const full = render(<RouteFallback fullScreen />);
    expect(full.container.firstElementChild).toHaveClass('min-h-screen');
    full.unmount();
    const normal = render(<RouteFallback />);
    expect(normal.container.firstElementChild).toHaveClass('min-h-[60vh]');
  });

  it('keeps one polite status region for assistive tech', async () => {
    const { container } = render(<RouteFallback variant="data" />);
    await tick(800);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
  });
});
