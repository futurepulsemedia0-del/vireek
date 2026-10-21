import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchRenewalKpis = vi.hoisted(() => vi.fn());
vi.mock('@/lib/membershipRenewal', async (orig) => ({ ...(await orig<typeof import('@/lib/membershipRenewal')>()), fetchRenewalKpis }));

import { RenewalRateCard } from './RenewalRateCard';

const KPIS = {
  window_days: 90, renewed: 9, lapsed: 1, cancelled: 0, renewal_rate: 90, open_cycles: 4, open_cycles_cents: 120000,
  at_risk_cents: 29900, active_members: 10, auto_charge_ready: 7, winback_recovered_cents: 0, winback_open_cents: 0,
};

const renderCard = () => render(<MemoryRouter><RenewalRateCard /></MemoryRouter>);

describe('RenewalRateCard', () => {
  beforeEach(() => fetchRenewalKpis.mockReset());

  it('shows the renewal rate, what is at risk and auto-charge coverage', async () => {
    fetchRenewalKpis.mockResolvedValue(KPIS);
    renderCard();
    expect(await screen.findByText('90%')).toBeInTheDocument();
    expect(screen.getByText(/9 of 10 renewed/)).toBeInTheDocument();
    expect(screen.getByText('$299')).toBeInTheDocument();
    expect(screen.getByText('70%')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /renewal pipeline/i })).toHaveAttribute('href', '/dashboard/memberships/renewals');
  });

  it('is honest when nothing has been decided yet', async () => {
    fetchRenewalKpis.mockResolvedValue({ ...KPIS, renewed: 0, lapsed: 0, renewal_rate: null, at_risk_cents: 0, active_members: 0, auto_charge_ready: 0 });
    renderCard();
    expect(await screen.findByText('—', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText(/No renewals decided yet/)).toBeInTheDocument();
  });

  it('shows a calm error state instead of crashing', async () => {
    fetchRenewalKpis.mockRejectedValue(new Error('boom'));
    renderCard();
    await waitFor(() => expect(screen.getByText(/Couldn’t load renewal data/)).toBeInTheDocument());
  });
});
