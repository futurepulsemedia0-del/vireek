import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const invoke = vi.fn();
const toast = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: {
    functions: { invoke: (...a: unknown[]) => invoke(...a) },
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'gte', 'order', 'range']) q[m] = () => q;
      q.then = (res: (v: unknown) => unknown) => Promise.resolve({ count: 0, data: [], error: null }).then(res);
      return q;
    },
  },
}));
vi.mock('@/lib/csvExport', () => ({ exportToCsv: vi.fn() }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ isOwner: true, profileLoading: false }) }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { CancelSubscriptionPage } from './CancelSubscriptionPage';

const CTX = {
  plan: 'professional', status: 'active', current_period_end: '2026-11-08T12:00:00Z', cancel_at_period_end: false, paused_until: null,
  price_cents: 19900, currency: 'USD', offer: null, save_offers_enabled: true,
};
const OFFERS = [
  { id: 'd1', kind: 'discount', name: 'x', discount_percent: 20, discount_months: 3 },
  { id: 'p1', kind: 'pause', name: 'y', pause_months: 2 },
  { id: 'g1', kind: 'downgrade', name: 'z', downgrade_plan: 'starter', downgrade_price_cents: 9900, downgrade_currency: 'USD', downgrade_minutes: 200 },
];
const ok = (data: unknown) => ({ data, error: null });
const failure = (error: string, code: string) => ({ data: null, error: { context: { json: async () => ({ error, code }) } } });

function respond(map: Record<string, unknown>) {
  invoke.mockImplementation(async (_n: string, { body }: { body: { action: string } }) => map[body.action] ?? ok(CTX));
}
const go = async () => {
  render(<MemoryRouter><CancelSubscriptionPage /></MemoryRouter>);
  await screen.findByText(/sorry to see you go/i);
  fireEvent.click(screen.getByLabelText(/too expensive/i));
  fireEvent.click(screen.getByRole('button', { name: /^continue/i }));
};

beforeEach(() => {
  invoke.mockReset();
  toast.mockReset();
});

describe('cancel flow with admin-configured save offers', () => {
  it('asks the server for offers with the chosen reason and renders all three kinds (legacy pause/coupon UI hidden)', async () => {
    respond({ offers: ok({ ...CTX, save_offers: OFFERS }) });
    await go();
    expect(await screen.findByText(/Stay and get 20% off/i)).toBeInTheDocument();
    expect(screen.getByText(/Pause billing for 2 month/i)).toBeInTheDocument();
    expect(screen.getByText(/Switch to the starter plan/i)).toBeInTheDocument();
    expect(screen.queryByText(/Pause instead of cancelling/i)).not.toBeInTheDocument();
    const call = invoke.mock.calls.find((c) => c[1].body.action === 'offers');
    expect(call?.[1].body).toMatchObject({ action: 'offers', reason: 'too_expensive' });
  });

  it('skips straight to confirm when the server returns no offers (caps used up)', async () => {
    respond({ offers: ok({ ...CTX, save_offers: [] }) });
    await go();
    expect(await screen.findByText(/Review and confirm/i)).toBeInTheDocument();
  });

  it('fails closed: an offers error still lets the customer cancel', async () => {
    respond({ offers: failure('boom', 'server_error') });
    await go();
    expect(await screen.findByText(/Review and confirm/i)).toBeInTheDocument();
  });

  it('accepting a discount sends accept_save_offer and shows the outcome', async () => {
    respond({
      offers: ok({ ...CTX, save_offers: OFFERS }),
      accept_save_offer: ok({ ...CTX, save_result: { kind: 'discount', percent_off: 20, months: 3 } }),
    });
    await go();
    fireEvent.click(await screen.findByRole('button', { name: /claim this discount/i }));
    expect(await screen.findByText(/Discount applied/i)).toBeInTheDocument();
    const call = invoke.mock.calls.find((c) => c[1].body.action === 'accept_save_offer');
    expect(call?.[1].body).toEqual({ action: 'accept_save_offer', offer_id: 'd1', reason: 'too_expensive', detail: '' });
  });

  it('shows the downgrade outcome', async () => {
    respond({
      offers: ok({ ...CTX, save_offers: OFFERS }),
      accept_save_offer: ok({ ...CTX, save_result: { kind: 'downgrade', plan: 'starter', effective_at: '2026-11-08T12:00:00Z' } }),
    });
    await go();
    fireEvent.click(await screen.findByRole('button', { name: /switch plan at period end/i }));
    expect(await screen.findByText(/plan change is scheduled/i)).toBeInTheDocument();
  });

  it('a server cap denial (offer_used) toasts the error and resyncs back to the survey', async () => {
    respond({
      offers: ok({ ...CTX, save_offers: OFFERS }),
      accept_save_offer: failure("You've already used a save offer on this account recently.", 'offer_used'),
    });
    await go();
    fireEvent.click(await screen.findByRole('button', { name: /pause my billing/i }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/already used/i), 'error'));
    expect(await screen.findByText(/sorry to see you go/i)).toBeInTheDocument();
  });

  it('keeps the legacy flow when save offers are not enabled', async () => {
    respond({ context: ok({ ...CTX, save_offers_enabled: false, offer: { percent_off: 30, months: 3 } }) });
    invoke.mockImplementation(async (_n: string, { body }: { body: { action: string } }) => ok({ ...CTX, save_offers_enabled: false, offer: { percent_off: 30, months: 3 } }));
    await go();
    expect(await screen.findByText(/Pause instead of cancelling/i)).toBeInTheDocument();
    expect(invoke.mock.calls.some((c) => c[1].body.action === 'offers')).toBe(false);
  });
});
