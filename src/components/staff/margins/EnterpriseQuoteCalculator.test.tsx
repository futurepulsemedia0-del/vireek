import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { EnterpriseQuoteCalculator } from './EnterpriseQuoteCalculator';

const set = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const row = (name: string) => within(screen.getByRole('row', { name: new RegExp(name) }));

describe('EnterpriseQuoteCalculator', () => {
  it('shows the default 6,000-minute quote with no margin warning', () => {
    render(<EnterpriseQuoteCalculator />);
    expect(row('List price / month').getByRole('cell')).toHaveTextContent('$1,800.00');
    expect(row('Monthly price floor').getByRole('cell')).toHaveTextContent('$1,754.55');
    expect(row('Overage / minute').getByRole('cell')).toHaveTextContent('20¢ per minute');
    expect(row('Onboarding').getByRole('cell')).toHaveTextContent('$2,500.00');
    expect(row('Annual contract').getByRole('cell')).toHaveTextContent('$21,600.00');
    expect(screen.queryByText(/below the 40% minimum/)).not.toBeInTheDocument();
  });

  it('warns when a discount pushes gross margin below 40%', () => {
    render(<EnterpriseQuoteCalculator />);
    set(/^Discount %/, '20');
    expect(screen.getByText(/below the 40% minimum/)).toBeInTheDocument();
    expect(row('Gross margin at full use').getByRole('cell')).toHaveTextContent('(below target)');
  });

  it('holds the $1,799 minimum for 2,000 minutes', () => {
    render(<EnterpriseQuoteCalculator />);
    set(/^Committed minutes/, '2000');
    expect(row('List price / month').getByRole('cell')).toHaveTextContent('$1,799.00');
  });

  it('shows a message instead of a quote for invalid input', () => {
    render(<EnterpriseQuoteCalculator />);
    set(/^Committed minutes/, '12abc');
    expect(screen.getByText('Enter a valid non-negative number in every field.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('surfaces module range errors (discount of 100%)', () => {
    render(<EnterpriseQuoteCalculator />);
    set(/^Discount %/, '100');
    expect(screen.getByText(/discount must be in \[0, 1\)/)).toBeInTheDocument();
  });

  it('shows the measured cost per minute as a reference only', () => {
    render(<EnterpriseQuoteCalculator measuredCostPerMinute={0.118} />);
    expect(screen.getByText(/reference only/)).toBeInTheDocument();
    expect(row('List price / month').getByRole('cell')).toHaveTextContent('$1,800.00');
  });
});
