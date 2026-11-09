import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QuoteFinancingOptions } from './QuoteFinancingOptions';

const fetchPublic = vi.fn();
const openApp = vi.fn();
vi.mock('@/lib/financingPartnersApi', () => ({
  fetchPublicQuoteFinancing: (...a: unknown[]) => fetchPublic(...a),
  openPartnerApplication: (...a: unknown[]) => openApp(...a),
}));

const offer = {
  available: true, offer_token: 't', status: 'offered', amount_cents: 500000, currency: 'USD', partner_name: 'Acme Lending',
  disclosure_version: 'v1', disclosure_body: 'Acme Lending decides.', expires_at: new Date(Date.now() + 86_400_000).toISOString(),
};

describe('QuoteFinancingOptions', () => {
  beforeEach(() => { fetchPublic.mockReset(); openApp.mockReset(); });

  it('renders nothing when the server says unavailable (flag/region gate)', async () => {
    fetchPublic.mockResolvedValue({ available: false });
    const { container } = render(<QuoteFinancingOptions quoteToken="q" />);
    await waitFor(() => expect(fetchPublic).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('states the partner is the lender and blocks apply until acknowledged', async () => {
    fetchPublic.mockResolvedValue(offer);
    render(<QuoteFinancingOptions quoteToken="q" />);
    expect(await screen.findByText(/not Vireek — is the lender/)).toBeTruthy();
    const btn = screen.getByRole('button', { name: /Check my options/ });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('checkbox'));
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows an error without opening anything when the server refuses', async () => {
    fetchPublic.mockResolvedValue(offer);
    openApp.mockRejectedValue(new Error('This offer is no longer open.'));
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<QuoteFinancingOptions quoteToken="q" />);
    await userEvent.click(await screen.findByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /Check my options/ }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
  });
});
