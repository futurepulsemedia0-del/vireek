import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BillingPlansPage } from './BillingPlansPage';

const mocks = vi.hoisted(() => ({ auth: {} as Record<string, unknown>, state: {} as Record<string, unknown> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/planChangeApi', () => ({
  fetchSubscriptionState: () => Promise.resolve(mocks.state),
  previewPlanChange: vi.fn(() => new Promise(() => {})),
  applyPlanChange: vi.fn(),
  cancelScheduledChange: vi.fn(),
  startPlanCheckout: vi.fn(),
}));

function setup(used: number) {
  mocks.auth = {
    profile: { plan: 'starter', subscription_status: 'active', minutes_used_this_month: used, minutes_included: 400 },
    profileLoading: false,
    isOwner: true,
    permissions: { can_view_billing: true },
    refreshProfile: vi.fn(),
  };
  mocks.state = {
    canManage: true, hasSubscription: true, status: 'active', currentPlanId: 'starter', currentPeriodEnd: '2026-12-01T00:00:00.000Z',
    cancelAtPeriodEnd: false, currency: 'usd', currentAmountMinor: 7900, paymentMethod: null, scheduledChange: null, prices: {},
  };
}
const renderPage = () => render(<MemoryRouter><BillingPlansPage /></MemoryRouter>);

beforeEach(() => vi.useRealTimers());

describe('BillingPlansPage — limits, trial and annual savings', () => {
  it('shows trial + annual-savings rows and per-card notes from pricing data', async () => {
    setup(10);
    renderPage();
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('row', { name: /Free trial/ })).toHaveTextContent('14-day trial');
    expect(within(table).getByRole('row', { name: /Annual billing/ })).toHaveTextContent('save $158 (2 months free)');
    expect(within(table).getByRole('row', { name: /Minutes included/ })).toHaveTextContent('1,500 min');
    expect(screen.getAllByText(/Annual: save \$\d+ \(2 months free\)/).length).toBe(3);
  });

  it('does not nag at low usage', async () => {
    setup(10);
    renderPage();
    await screen.findByRole('table');
    expect(screen.queryByText(/would cost about the same or less/)).toBeNull();
  });

  it('suggests the next plan when the projected cost reaches its price, and opens the change dialog', async () => {
    // Pace so high that Starter + overage >= Professional regardless of the day of the month.
    setup(100000);
    renderPage();
    const notice = await screen.findByText(/Professional would cost about the same or less/);
    expect(notice).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /See Professional/ }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});
