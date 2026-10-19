import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DeltaBadge } from './DeltaBadge';
import { computeDelta } from '@/lib/dateRange';

// Vitest globals are off in this project, so RTL's auto-cleanup isn't registered.
afterEach(cleanup);

describe('DeltaBadge', () => {
  it('renders nothing when comparison is off (delta = null)', () => {
    const { container } = render(<DeltaBadge delta={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a good, rising change with an accessible sentence', () => {
    render(<DeltaBadge delta={computeDelta(150, 100)} versus="Sep 11 – Oct 10" />);
    const badge = screen.getByTestId('delta-badge');
    expect(badge).toHaveAttribute('data-direction', 'up');
    expect(badge).toHaveAttribute('data-sentiment', 'good');
    expect(badge).toHaveTextContent('+50.0%');
    expect(screen.getByText('Up 50.0% versus Sep 11 – Oct 10')).toBeInTheDocument();
  });

  it('colours a falling cost as good but keeps the down direction', () => {
    render(<DeltaBadge delta={computeDelta(80, 100, { polarity: 'lowerIsBetter' })} />);
    const badge = screen.getByTestId('delta-badge');
    expect(badge).toHaveAttribute('data-direction', 'down');
    expect(badge).toHaveAttribute('data-sentiment', 'good');
  });

  it('shows "New" when the previous period had nothing', () => {
    render(<DeltaBadge delta={computeDelta(4, 0)} />);
    expect(screen.getByTestId('delta-badge')).toHaveTextContent('New');
  });

  it('shows percentage points for rates', () => {
    render(<DeltaBadge delta={computeDelta(45, 40, { kind: 'points' })} />);
    expect(screen.getByTestId('delta-badge')).toHaveTextContent('+5.0 pts');
  });

  it('is muted when there is no data to compare, and exposes the previous value as a tooltip', () => {
    const { rerender } = render(<DeltaBadge delta={computeDelta(null, 3)} />);
    expect(screen.getByTestId('delta-badge')).toHaveAttribute('data-direction', 'none');
    rerender(<DeltaBadge delta={computeDelta(5, 4)} />);
    expect(screen.getByTestId('delta-badge')).toHaveAttribute(
      'title',
      expect.stringContaining('previous: 4'),
    );
    rerender(<DeltaBadge delta={computeDelta(5, 4)} format={(n) => `$${n}.00`} />);
    expect(screen.getByTestId('delta-badge')).toHaveAttribute(
      'title',
      expect.stringContaining('previous: $4.00'),
    );
  });
});
