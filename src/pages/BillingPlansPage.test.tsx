import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BillingPlansPage } from './BillingPlansPage';
import type { PlanChangePreview, SubscriptionState } from '@/lib/planChange';

const mocks = vi.hoisted(() => ({
  auth: {} as Record<string, unknown>,
  toast: vi.fn(),
  fetchSubscriptionState: vi.fn(),
  previewPlanChange: vi.fn(),
  applyPlanChange: vi.fn(),
  cancelScheduledChange: vi.fn(),
  startPlanCheckout: vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/components/DashboardNav', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/planChangeApi', () => ({
  fetchSubscriptionState: mocks.fetchSubscriptionState,
  previewPlanChange: mocks.previewPlanChange,
  applyPlanChange: mocks.applyPlanChange,
  cancelScheduledChange: mocks.cancelScheduledChange,
  startPlanCheckout: mocks.startPlanCheckout,
}));

function setAuth(overrides: Record<string, unknown> = {}) {
  mocks.auth = {
    profile: { plan: 'starter', subscription_status: 'active', minutes_used_this_month: 120, minutes_included: 400 },
    profileLoading: false,
    isOwner: true,
    permissions: { can_view_billing: true },
    refreshProfile: vi.fn(),
    ...overrides,
  };
}

function subscriptionState(overrides: Partial<SubscriptionState> = {}): SubscriptionState {
  return {
    canManage: true,
    hasSubscription: true,
    status: 'active',
    currentPlanId: 'starter',
    currentPeriodEnd: '2026-11-01T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    currency: 'usd',
    currentAmountMinor: 7900,
    paymentMethod: { brand: 'visa', last4: '4242' },
    scheduledChange: null,
    prices: {},
    ...overrides,
  };
}

const upgradePreview: PlanChangePreview = {
  kind: 'upgrade',
  currentPlanId: 'starter',
  targetPlanId: 'professional',
  currency: 'usd',
  interval: 'month',
  effectiveAt: '2026-10-08T00:00:00.000Z',
  nextBillingDate: '2026-11-01T00:00:00.000Z',
  dueNowMinor: 4250,
  creditMinor: 0,
  lines: [
    { description: 'Unused time on Starter', amountMinor: -2000 },
    { description: 'Remaining time on Professional', amountMinor: 6250 },
  ],
  newRecurringMinor: 19900,
  taxesApply: false,
  hasDiscount: false,
  prorationDate: 1791417600,
};

function renderPage() {
  return render(
    <MemoryRouter>
      <BillingPlansPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setAuth();
});

describe('BillingPlansPage', () => {
  it('blocks members without billing permission and never calls Stripe', async () => {
    setAuth({ isOwner: false, permissions: { can_view_billing: false } });
    renderPage();
    expect(await screen.findByText("You don't have access to this page")).toBeInTheDocument();
    expect(mocks.fetchSubscriptionState).not.toHaveBeenCalled();
  });

  it('shows a retryable error state when billing cannot be loaded', async () => {
    mocks.fetchSubscriptionState.mockRejectedValueOnce(new Error('Stripe is down'));
    renderPage();
    expect(await screen.findByText("We couldn't load your plans")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('lets the owner preview the exact prorated amount before confirming an upgrade', async () => {
    mocks.fetchSubscriptionState.mockResolvedValueOnce(subscriptionState());
    mocks.previewPlanChange.mockResolvedValueOnce(upgradePreview);
    renderPage();

    expect(await screen.findByRole('button', { name: 'Current plan' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Professional' }));

    expect(mocks.previewPlanChange).toHaveBeenCalledWith('professional');
    expect(await screen.findByRole('button', { name: 'Pay $42.50 & upgrade' })).toBeEnabled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(mocks.applyPlanChange).not.toHaveBeenCalled();
  });

  it('keeps plan changes read-only for team members who can only view billing', async () => {
    setAuth({ isOwner: false, permissions: { can_view_billing: true } });
    mocks.fetchSubscriptionState.mockResolvedValueOnce(subscriptionState({ canManage: false }));
    renderPage();

    expect(await screen.findByRole('button', { name: 'Upgrade to Professional' })).toBeDisabled();
    expect(screen.getByText('Only the account owner can change plans.')).toBeInTheDocument();
  });
});
