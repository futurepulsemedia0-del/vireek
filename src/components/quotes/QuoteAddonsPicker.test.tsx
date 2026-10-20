import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { QuoteAddonsPicker } from './QuoteAddonsPicker';
import type { PublicQuoteAddon } from '@/lib/quoteAddons';

const addons: PublicQuoteAddon[] = [
  { id: 'w', name: 'Extended warranty', description: '5 years parts and labour', quantity: 1, unit_price_cents: 14_900, option_ids: [] },
  { id: 'f', name: 'Filter upgrade', description: '', quantity: 2, unit_price_cents: 3_000, option_ids: [] },
];

describe('QuoteAddonsPicker', () => {
  it('renders nothing when there are no add-ons', () => {
    const { container } = render(<QuoteAddonsPicker addons={[]} selectedIds={[]} onToggle={vi.fn()} taxPercent={0} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows each add-on as an accessible checkbox with its line price', () => {
    render(<QuoteAddonsPicker addons={addons} selectedIds={[]} onToggle={vi.fn()} taxPercent={0} />);
    expect(screen.getByRole('checkbox', { name: /Extended warranty/ })).not.toBeChecked();
    expect(screen.getByText('+$149.00')).toBeInTheDocument();
    expect(screen.getByText('+$60.00')).toBeInTheDocument();
    expect(screen.getByTestId('addons-summary')).toHaveTextContent('No add-ons selected');
  });

  it('reports toggles by id and reflects the controlled selection + tax in the summary', () => {
    const onToggle = vi.fn();
    const { rerender } = render(<QuoteAddonsPicker addons={addons} selectedIds={[]} onToggle={onToggle} taxPercent={10} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Filter upgrade/ }));
    expect(onToggle).toHaveBeenCalledWith('f');

    rerender(<QuoteAddonsPicker addons={addons} selectedIds={['f']} onToggle={onToggle} taxPercent={10} />);
    expect(screen.getByRole('checkbox', { name: /Filter upgrade/ })).toBeChecked();
    expect(screen.getByTestId('addons-summary')).toHaveTextContent('1 add-on selected: +$66.00 incl. tax');
  });

  it('cannot be toggled while disabled', () => {
    render(<QuoteAddonsPicker addons={addons} selectedIds={[]} onToggle={vi.fn()} taxPercent={0} disabled />);
    expect(screen.getByRole('checkbox', { name: /Extended warranty/ })).toBeDisabled();
  });
});
