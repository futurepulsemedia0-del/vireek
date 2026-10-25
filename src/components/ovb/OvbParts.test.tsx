import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {}, isSupabaseConfigured: false }));

import { DimensionBars, ProvenanceBadge, ScoreBadge, TrendChart } from './OvbParts';

describe('OvbParts', () => {
  it('labels provenance honestly', () => {
    render(<><ProvenanceBadge provenance="first_party" /><ProvenanceBadge provenance="vendor_submitted" /><ProvenanceBadge provenance="independent" /></>);
    expect(screen.getByText('First-party')).toBeInTheDocument();
    expect(screen.getByText('Vendor-submitted')).toBeInTheDocument();
    expect(screen.getByText('Independently run')).toBeInTheDocument();
  });
  it('formats scores and handles missing values', () => {
    render(<><ScoreBadge score={91.234} label="Overall" /><ScoreBadge score={null} /></>);
    expect(screen.getByLabelText('Overall: 91.2')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });
  it('renders accessible dimension bars', () => {
    render(<DimensionBars dimensions={{ booking: { score: 80 }, safety: 100 }} />);
    expect(screen.getByRole('img', { name: 'Booking correctness 80.0 out of 100' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Safety escalation 100.0 out of 100' })).toBeInTheDocument();
  });
  it('renders a trend chart with one marker per run and nothing when empty', () => {
    const { container, rerender } = render(<TrendChart points={[{ x: 0, label: 'a', overall: 70, heldOut: 65, retracted: false }, { x: 1, label: 'b', overall: 80, heldOut: null, retracted: true }]} />);
    expect(container.querySelectorAll('circle')).toHaveLength(2);
    rerender(<TrendChart points={[]} />);
    expect(container.querySelector('svg')).toBeNull();
  });
});
