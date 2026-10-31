import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bidi } from '@/components/format/Bidi';
import { RelativeTime } from '@/components/format/RelativeTime';
import { TICK_MS } from '@/lib/timeTicker';

afterEach(() => vi.useRealTimers());

describe('<RelativeTime>', () => {
  it('renders <time datetime> with the exact time in the title and keeps itself current', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-29T12:00:00Z'));
    const { container } = render(<RelativeTime value="2026-10-29T11:58:00Z" />);
    const el = container.querySelector('time');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('datetime')).toBe('2026-10-29T11:58:00.000Z');
    expect(el?.getAttribute('title')).toBeTruthy();
    expect(screen.getByText('2 minutes ago')).toBeInTheDocument();
    act(() => {
      vi.setSystemTime(new Date('2026-10-29T12:03:00Z'));
      vi.advanceTimersByTime(TICK_MS);
    });
    expect(screen.getByText('5 minutes ago')).toBeInTheDocument();
  });

  it('shows the empty marker without a <time> element for missing values', () => {
    const { container } = render(<RelativeTime value={null} />);
    expect(container.querySelector('time')).toBeNull();
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('<Bidi>', () => {
  it('isolates LTR tokens', () => {
    const { container } = render(<Bidi>+49 30 1234567</Bidi>);
    const el = container.querySelector('bdi');
    expect(el?.getAttribute('dir')).toBe('ltr');
  });
});
