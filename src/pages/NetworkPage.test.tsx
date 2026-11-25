import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkPage } from '@/pages/NetworkPage';

let impl: () => Promise<unknown> = async () => ({});
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: () => impl().then((data) => ({ data, error: null })).catch(() => ({ data: null, error: { message: 'x' } })) } }));
vi.mock('@/components/Header', () => ({ Header: () => null }));
vi.mock('@/components/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/CookieConsent', () => ({ CookieConsent: () => null }));
vi.mock('@/lib/seo', () => ({ useSEO: () => undefined }));

const r = (o: Record<string, unknown>) => ({ unit: 'percent', direction: 'higher_is_better', window_days: 90, scope: 'platform', industry: null, contributors: 14, p25: 70, p50: 81.2, p75: 90, computed_at: new Date().toISOString(), ...o });
const renderPage = () => render(<MemoryRouter><NetworkPage /></MemoryRouter>);

describe('NetworkPage', () => {
  beforeEach(() => { impl = async () => ({}); });

  it('shows real values and explicit "insufficient data" for metrics that lack k', async () => {
    impl = async () => ({ k_threshold: 10, rows: [r({ metric: 'first_time_fix_rate' })] });
    renderPage();
    const ftf = await screen.findByTestId('platform-first_time_fix_rate');
    expect(within(ftf).getByText('81.2%')).toBeTruthy();
    expect(within(screen.getByTestId('platform-reservice_rate')).getByText(/insufficient data/i)).toBeTruthy();
    expect(within(screen.getByTestId('platform-median_response_minutes')).getByText(/insufficient data/i)).toBeTruthy();
  });

  it('shows empty-state for trades when none clear k, and never renders rows below k', async () => {
    impl = async () => ({ k_threshold: 10, rows: [r({ scope: 'industry', industry: 'hvac', contributors: 4, metric: 'first_time_fix_rate' })] });
    renderPage();
    expect(await screen.findByText(/no trade has enough contributing businesses/i)).toBeTruthy();
    expect(screen.queryByText('Hvac')).toBeNull();
  });

  it('lists a trade with its contributor count when it clears k', async () => {
    impl = async () => ({ k_threshold: 10, rows: [r({ scope: 'industry', industry: 'hvac', contributors: 11, metric: 'first_time_fix_rate' })] });
    renderPage();
    expect(await screen.findByRole('rowheader', { name: 'Hvac' })).toBeTruthy();
    expect(screen.getByText(/81\.2% \(11\)/)).toBeTruthy();
  });

  it('shows a retryable error state when the RPC fails', async () => {
    impl = () => Promise.reject(new Error('x'));
    renderPage();
    await waitFor(() => expect(screen.getByText(/network data is unavailable/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });
});
