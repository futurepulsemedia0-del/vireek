import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaxBreakdownLines } from './TaxBreakdownLines';

describe('TaxBreakdownLines', () => {
  it('renders one line per jurisdiction', () => {
    render(
      <TaxBreakdownLines
        taxPercent={8.25}
        taxCents={825}
        breakdown={[
          { level: 'state', name: 'Texas state sales tax', rate_percent: 6.25, taxable_cents: 10000, tax_cents: 625 },
          { level: 'city', name: 'Austin', rate_percent: 2, taxable_cents: 10000, tax_cents: 200 },
        ]}
      />
    );
    expect(screen.getByText('$6.25')).toBeInTheDocument();
    expect(screen.getByText('$2.00')).toBeInTheDocument();
    expect(screen.getByText(/Texas state sales tax/)).toBeInTheDocument();
    expect(screen.getByText('(6.25%)')).toBeInTheDocument();
  });

  it('falls back to a single line for legacy documents', () => {
    render(<TaxBreakdownLines breakdown={[]} taxPercent={7.5} taxCents={750} />);
    expect(screen.getByText('$7.50')).toBeInTheDocument();
    expect(screen.getByText(/Sales tax/)).toBeInTheDocument();
  });

  it('shows the exempt line and renders nothing when there is no tax', () => {
    const { rerender, container } = render(<TaxBreakdownLines breakdown={[]} taxPercent={0} taxCents={0} taxExempt />);
    expect(screen.getByText(/exempt/)).toBeInTheDocument();
    rerender(<TaxBreakdownLines breakdown={[]} taxPercent={0} taxCents={0} />);
    expect(container).toBeEmptyDOMElement();
  });
});
