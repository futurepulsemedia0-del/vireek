import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { UsageDashboardPage } from './UsageDashboardPage';

const mocks = vi.hoisted(() => ({ auth: {} as Record<string, unknown> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/supabase', () => {
  const callsChain = { select: () => callsChain, gte: () => callsChain, order: () => Promise.resolve({ data: [], error: null }) };
  const countChain = (count: number) => {
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.eq = () => c;
    c.neq = () => Promise.resolve({ count, error: null });
    c.then = (res: (v: unknown) => unknown) => Promise.resolve({ count, error: null }).then(res);
    return c;
  };
  return {
    supabase: {
      from: (table: string) => (table === 'calls' ? callsChain : table === 'team_members' ? countChain(2) : countChain(3)),
    },
  };
});

function setAuth(profile: Record<string, unknown>) {
  mocks.auth = { user: { id: 'u1' }, profile: { id: 'u1', onboarding_completed: true, subscription_status: 'active', ...profile }, profileLoading: false };
}
const renderPage = () => render(<MemoryRouter><UsageDashboardPage /></MemoryRouter>);
beforeEach(() => setAuth({ plan: 'professional', minutes_included: 1500, minutes_used_this_month: 300 }));

describe('UsageDashboardPage — plan limits', () => {
  it('shows minutes breakdown with bonus, billing period, seats and numbers vs plan limits', async () => {
    setAuth({ plan: 'professional', minutes_included: 1500, bonus_minutes: 200, minutes_used_this_month: 300 });
    renderPage();
    const card = await screen.findByRole('region', { name: /Plan limits/ });
    expect(card).toHaveTextContent('1,500 included + 200 bonus');
    expect(card).toHaveTextContent('1,400 remaining');
    expect(card).toHaveTextContent(/\w{3} 1 – \w{3} \d{2}, \d{4}/);
    expect(card).toHaveTextContent('3 / 5'); // owner + 2 team members of 5 seats
    expect(card).toHaveTextContent('Up to 1');
    expect(card).toHaveTextContent(/3\s*in use/); // phone numbers in use
  });

  it('shows overage minutes x rate for a billed plan that is over its allowance', async () => {
    setAuth({ plan: 'starter', minutes_included: 400, minutes_used_this_month: 450 });
    renderPage();
    const card = await screen.findByRole('region', { name: /Plan limits/ });
    expect(card).toHaveTextContent('$10.00'); // 50 min x $0.20
    expect(card).toHaveTextContent('50 min × $0.20/min');
  });

  it('explains Free as blocking instead of billing, and Enterprise as not metered', async () => {
    setAuth({ plan: 'free', minutes_included: 50, minutes_used_this_month: 5 });
    const a = renderPage();
    expect(await screen.findByText(/answering pauses at the limit/)).toBeInTheDocument();
    a.unmount();
    setAuth({ plan: 'enterprise', minutes_included: 0, minutes_used_this_month: 5000 });
    renderPage();
    expect(await screen.findByText('Not metered')).toBeInTheDocument();
  });
});
