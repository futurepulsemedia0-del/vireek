import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { UsageLimitBanner } from './UsageLimitBanner';
import { PRICING_PLANS, parseOverageRate } from '@/lib/pricing';

const mocks = vi.hoisted(() => ({ auth: {} as Record<string, unknown>, navigate: vi.fn() }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => mocks.auth }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));

function setProfile(profile: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
  mocks.auth = {
    user: { id: 'u1' },
    profileLoading: false,
    profile: profile && { subscription_status: 'active', bonus_minutes: undefined, ...profile },
    ...extra,
  };
}
const starterRate = parseOverageRate(PRICING_PLANS.find((p) => p.id === 'starter')!.overage)!;

beforeEach(() => {
  window.localStorage.clear();
  mocks.navigate.mockReset();
  setProfile({ plan: 'starter', minutes_included: 400, minutes_used_this_month: 0 });
});

describe('UsageLimitBanner', () => {
  it('renders nothing below 80%', () => {
    setProfile({ plan: 'starter', minutes_included: 400, minutes_used_this_month: 319 });
    const { container } = render(<UsageLimitBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while loading, without a profile, for unlimited plans, and when suspended', () => {
    setProfile({ plan: 'starter', minutes_included: 400, minutes_used_this_month: 400 }, { profileLoading: true });
    expect(render(<UsageLimitBanner />).container).toBeEmptyDOMElement();
    setProfile(null);
    expect(render(<UsageLimitBanner />).container).toBeEmptyDOMElement();
    setProfile({ plan: 'enterprise', minutes_included: 0, minutes_used_this_month: 99999 });
    expect(render(<UsageLimitBanner />).container).toBeEmptyDOMElement();
    setProfile({ plan: 'starter', minutes_included: 400, minutes_used_this_month: 400, subscription_status: 'suspended' });
    expect(render(<UsageLimitBanner />).container).toBeEmptyDOMElement();
  });

  it('80% on a billed plan: polite status, rate from pricing data, Upgrade, no top-up button', () => {
    setProfile({ plan: 'starter', minutes_included: 400, minutes_used_this_month: 320 });
    render(<UsageLimitBanner />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveAttribute('aria-live', 'polite');
    expect(banner).toHaveTextContent('80%');
    expect(banner).toHaveTextContent(`Extra minutes cost $${starterRate.toFixed(2)}/min`);
    expect(screen.getByRole('button', { name: 'Upgrade' })).toBeInTheDocument();
    expect(screen.queryByText(/buy 100 minutes/i)).toBeNull();
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });

  it('100% on a billed plan: alert with overage estimate, dismissible', () => {
    setProfile({ plan: 'starter', minutes_included: 400, minutes_used_this_month: 410 });
    render(<UsageLimitBanner />);
    const banner = screen.getByRole('alert');
    expect(banner).toHaveAttribute('aria-live', 'polite');
    expect(banner).toHaveTextContent(`$${starterRate.toFixed(2)}/min`);
    expect(banner).toHaveTextContent(`$${(10 * starterRate).toFixed(2)} in overage`);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('80% on Free (block): pause wording, no emergency claim', () => {
    setProfile({ plan: 'free', minutes_included: 50, minutes_used_this_month: 41 });
    render(<UsageLimitBanner />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Voice answering pauses at the limit');
    expect(banner.textContent?.toLowerCase()).not.toContain('emergenc');
  });

  it('100% on Free (block): danger alert that cannot be dismissed', () => {
    setProfile({ plan: 'free', minutes_included: 50, minutes_used_this_month: 50 });
    render(<UsageLimitBanner />);
    expect(screen.getByRole('alert')).toHaveTextContent('paused answering new calls');
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Upgrade' })).toBeInTheDocument();
  });

  it('counts bonus minutes toward the allowance', () => {
    setProfile({ plan: 'starter', minutes_included: 400, bonus_minutes: 100, minutes_used_this_month: 400 });
    render(<UsageLimitBanner />);
    // 400 of 500 is a warning, not the limit
    expect(screen.getByRole('status')).toHaveTextContent('includes 100 bonus');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a dismissal at 80% does not hide the 100% banner (dismissal is per level)', () => {
    setProfile({ plan: 'starter', minutes_included: 400, minutes_used_this_month: 330 });
    const first = render(<UsageLimitBanner />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByRole('status')).toBeNull();
    first.unmount();

    setProfile({ plan: 'starter', minutes_included: 400, minutes_used_this_month: 330 });
    expect(render(<UsageLimitBanner />).container).toBeEmptyDOMElement(); // stays dismissed this month
    setProfile({ plan: 'starter', minutes_included: 400, minutes_used_this_month: 401 });
    render(<UsageLimitBanner />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('Upgrade navigates to billing', () => {
    setProfile({ plan: 'starter', minutes_included: 400, minutes_used_this_month: 400 });
    render(<UsageLimitBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/dashboard/billing');
  });
});
