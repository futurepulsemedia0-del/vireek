import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const fetchQuoteForToken = vi.fn();
const respondToQuote = vi.fn();
const fetchQuoteAddons = vi.fn();
const acceptQuoteWithAddons = vi.fn();

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/components/Header', () => ({ Header: () => null }));
vi.mock('@/components/Footer', () => ({ Footer: () => null }));
vi.mock('@/lib/quotes', async () => {
  const actual = await vi.importActual<typeof import('@/lib/quotes')>('@/lib/quotes');
  return {
    ...actual,
    fetchQuoteForToken: (...a: unknown[]) => fetchQuoteForToken(...a),
    respondToQuote: (...a: unknown[]) => respondToQuote(...a),
    recordQuoteView: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('@/lib/quoteAddons', async () => {
  const actual = await vi.importActual<typeof import('@/lib/quoteAddons')>('@/lib/quoteAddons');
  return {
    ...actual,
    fetchQuoteAddons: (...a: unknown[]) => fetchQuoteAddons(...a),
    acceptQuoteWithAddons: (...a: unknown[]) => acceptQuoteWithAddons(...a),
  };
});

import { QuoteAcceptPage } from './QuoteAcceptPage';

const quote = {
  quote_id: 'q1',
  customer_name: 'Dana',
  line_items: [{ description: 'Furnace tune-up', quantity: 1, unit_price_cents: 20_000 }],
  options: [],
  photos: [],
  recommended_option_id: null,
  selected_option_id: null,
  presentation_note: null,
  deposit_percent: 0,
  tax_percent: 10,
  status: 'sent',
  valid_until: null,
  business_name: 'Acme HVAC',
  financing_partner_name: null,
  financing_note: null,
  promo_discount_cents: 0,
  promo_codes: [],
};

const addons = [
  { id: 'w', name: 'Extended warranty', description: '', quantity: 1, unit_price_cents: 10_000, option_ids: [] },
  { id: 's', name: 'Surge protector', description: '', quantity: 1, unit_price_cents: 5_000, option_ids: [] },
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/quote/tok']}>
      <Routes>
        <Route path="/quote/:token" element={<QuoteAcceptPage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchQuoteForToken.mockResolvedValue(quote);
  fetchQuoteAddons.mockResolvedValue(addons);
  respondToQuote.mockResolvedValue(true);
});

describe('QuoteAcceptPage — optional add-ons (classic quote)', () => {
  it('recalculates the total live as add-ons are toggled', async () => {
    renderPage();
    await screen.findByText('Extended warranty');
    expect(screen.getByText('$220.00')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /Extended warranty/ }));
    expect(screen.getByText('$330.00')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /Surge protector/ }));
    expect(screen.getByText('$385.00')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /Extended warranty/ }));
    expect(screen.getByText('$275.00')).toBeInTheDocument();
  });

  it('accepts through the add-ons RPC, sending ids only', async () => {
    acceptQuoteWithAddons.mockResolvedValue({ ok: true, addonsTotalCents: 5_500, totalCents: 27_500 });
    renderPage();
    await screen.findByText('Surge protector');
    fireEvent.click(screen.getByRole('checkbox', { name: /Surge protector/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Accept quote' }));

    await waitFor(() => expect(acceptQuoteWithAddons).toHaveBeenCalledWith('tok', null, ['s']));
    expect(respondToQuote).not.toHaveBeenCalled();
    expect(await screen.findByText('Quote accepted')).toBeInTheDocument();
  });

  it('uses the original accept path when no add-on is ticked', async () => {
    renderPage();
    await screen.findByText('Surge protector');
    fireEvent.click(screen.getByRole('button', { name: 'Accept quote' }));
    await waitFor(() => expect(respondToQuote).toHaveBeenCalledWith('tok', 'accepted', null));
    expect(acceptQuoteWithAddons).not.toHaveBeenCalled();
  });

  it('keeps the customer on the page with a clear message when the server refuses', async () => {
    acceptQuoteWithAddons.mockResolvedValue({ ok: false, reason: 'invalid_items' });
    renderPage();
    await screen.findByText('Surge protector');
    fireEvent.click(screen.getByRole('checkbox', { name: /Surge protector/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Accept quote' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer available/i);
    expect(screen.queryByText('Quote accepted')).not.toBeInTheDocument();
  });

  it('behaves exactly as before when the quote has no add-ons', async () => {
    fetchQuoteAddons.mockResolvedValue([]);
    renderPage();
    await screen.findByText('Furnace tune-up');
    expect(screen.queryByText('Optional add-ons')).not.toBeInTheDocument();
    expect(screen.getByText('$220.00')).toBeInTheDocument();
  });
});
