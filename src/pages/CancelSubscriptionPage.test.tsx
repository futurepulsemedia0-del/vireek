import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const invoke = vi.fn();
const fromMock = vi.fn();
const exportToCsv = vi.fn();
const toast = vi.fn();
const navigate = vi.fn();
const auth = { isOwner: true, profileLoading: false };

vi.mock('@/lib/supabase', () => ({
  supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) }, from: (...a: unknown[]) => fromMock(...a) },
}));
vi.mock('@/lib/csvExport', () => ({ exportToCsv: (...a: unknown[]) => exportToCsv(...a) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

import { CancelSubscriptionPage } from './CancelSubscriptionPage';

const CTX = {
  plan: 'professional',
  status: 'active',
  current_period_end: '2026-11-08T12:00:00Z',
  cancel_at_period_end: false,
  paused_until: null as string | null,
  price_cents: 19900,
  currency: 'USD',
  offer: { percent_off: 30, months: 3 } as { percent_off: number; months: number } | null,
};

type Reply = { data: unknown; error: unknown };
const ok = (data: unknown): Reply => ({ data, error: null });
const failure = (error: string, code: string): Reply => ({ data: null, error: { context: { json: async () => ({ error, code }) } } });

function respond(map: Partial<Record<string, Reply>> = {}) {
  invoke.mockImplementation(async (_name: string, { body }: { body: { action: string } }) => map[body.action] ?? ok(CTX));
}

function query(opts: { count?: number; data?: unknown[] } = {}) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'order', 'range']) q[m] = () => q;
  q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve({ count: opts.count ?? 0, data: opts.data ?? [], error: null }).then(res, rej);
  return q;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <CancelSubscriptionPage />
    </MemoryRouter>,
  );

const pickReason = (label: RegExp) => fireEvent.click(screen.getByLabelText(label));
const clickBtn = (name: RegExp) => fireEvent.click(screen.getByRole('button', { name }));

async function toConfirmStep() {
  renderPage();
  await screen.findByRole('heading', { name: /sorry to see you go/i });
  pickReason(/too expensive/i);
  clickBtn(/^continue$/i);
  await screen.findByRole('heading', { name: /before you go/i });
  clickBtn(/no thanks, continue to cancel/i);
  await screen.findByRole('heading', { name: /review and confirm/i });
}

beforeEach(() => {
  invoke.mockReset();
  fromMock.mockReset();
  exportToCsv.mockReset();
  toast.mockReset();
  navigate.mockReset();
  auth.isOwner = true;
  auth.profileLoading = false;
  respond();
  fromMock.mockImplementation(() => query({ count: 12 }));
});

describe('CancelSubscriptionPage — states', () => {
  it('shows an accessible loading state, then the survey with real plan data', async () => {
    renderPage();
    expect(screen.getByRole('status')).toHaveTextContent(/loading your subscription/i);
    expect(await screen.findByRole('heading', { name: /sorry to see you go/i })).toBeInTheDocument();
    expect(screen.getByText(/professional plan/i)).toHaveTextContent('$199.00/mo');
    expect(screen.getByText(/professional plan/i)).toHaveTextContent('November 8, 2026');
  });

  it('blocks non-owners without calling the backend', async () => {
    auth.isOwner = false;
    renderPage();
    expect(await screen.findByRole('heading', { name: /only the account owner/i })).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('shows an empty state when there is no paid subscription', async () => {
    respond({ context: failure('none', 'no_subscription') });
    renderPage();
    expect(await screen.findByText(/no paid subscription to cancel/i)).toBeInTheDocument();
  });

  it('shows an ended state for a finished subscription', async () => {
    respond({ context: failure('ended', 'subscription_ended') });
    renderPage();
    expect(await screen.findByText(/already ended/i)).toBeInTheDocument();
  });

  it('shows an error with a working retry', async () => {
    respond({ context: failure('Stripe is down', 'server_error') });
    renderPage();
    expect(await screen.findByText(/couldn't load your subscription/i)).toBeInTheDocument();
    respond();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('heading', { name: /sorry to see you go/i })).toBeInTheDocument();
  });

  it('shows the scheduled-cancellation banner and lets the user undo it', async () => {
    respond({
      context: ok({ ...CTX, cancel_at_period_end: true, offer: null }),
      resume: ok({ ...CTX, cancel_at_period_end: false }),
    });
    renderPage();
    expect(await screen.findByRole('heading', { name: /cancellation is scheduled/i })).toBeInTheDocument();
    clickBtn(/keep my subscription/i);
    expect(await screen.findByRole('heading', { name: /you’re all set/i })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('manage-subscription-cancellation', { body: { action: 'resume' } });
  });

  it('shows the paused banner with the resume date', async () => {
    respond({ context: ok({ ...CTX, paused_until: '2026-12-08T12:00:00Z', offer: null }) });
    renderPage();
    expect(await screen.findByRole('heading', { name: /billing is paused/i })).toBeInTheDocument();
    expect(screen.getByText(/december 8, 2026/i)).toBeInTheDocument();
  });
});

describe('CancelSubscriptionPage — survey', () => {
  it('requires a reason before continuing', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /sorry to see you go/i });
    clickBtn(/^continue$/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/pick the closest reason/i);
    expect(screen.queryByRole('heading', { name: /before you go/i })).not.toBeInTheDocument();
  });

  it('marks the current step for assistive tech', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /sorry to see you go/i });
    const current = within(screen.getByRole('list', { name: /progress/i })).getAllByRole('listitem').find((li) => li.getAttribute('aria-current') === 'step');
    expect(current).toHaveTextContent(/feedback/i);
  });

  it('skips the alternatives when the business is closing', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /sorry to see you go/i });
    pickReason(/closing or selling/i);
    clickBtn(/^continue$/i);
    expect(await screen.findByRole('heading', { name: /review and confirm/i })).toBeInTheDocument();
  });

  it('skips alternatives when the subscription cannot be modified (e.g. past due)', async () => {
    respond({ context: ok({ ...CTX, status: 'past_due', offer: null }) });
    renderPage();
    await screen.findByRole('heading', { name: /sorry to see you go/i });
    pickReason(/too expensive/i);
    clickBtn(/^continue$/i);
    expect(await screen.findByRole('heading', { name: /review and confirm/i })).toBeInTheDocument();
  });
});

describe('CancelSubscriptionPage — alternatives', () => {
  async function toAlternatives() {
    renderPage();
    await screen.findByRole('heading', { name: /sorry to see you go/i });
    pickReason(/too expensive/i);
    fireEvent.change(screen.getByLabelText(/anything we could have done better/i), { target: { value: ' pricey ' } });
    clickBtn(/^continue$/i);
    await screen.findByRole('heading', { name: /before you go/i });
  }

  it('shows the real win-back terms and applies the offer with the survey answer', async () => {
    respond({ accept_offer: ok({ ...CTX, offer: null }) });
    await toAlternatives();
    expect(screen.getByText(/stay and get 30% off for 3 months/i)).toBeInTheDocument();
    clickBtn(/claim 30% off/i);
    expect(await screen.findByRole('heading', { name: /offer applied/i })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('manage-subscription-cancellation', {
      body: { action: 'accept_offer', reason: 'too_expensive', detail: 'pricey' },
    });
  });

  it('hides the offer when the server says none is available', async () => {
    respond({ context: ok({ ...CTX, offer: null }) });
    await toAlternatives();
    expect(screen.queryByText(/one-time offer/i)).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: /pause billing/i })).toBeInTheDocument();
  });

  it('pauses billing for the chosen number of months', async () => {
    respond({ pause: ok({ ...CTX, paused_until: '2027-01-08T12:00:00Z', offer: null }) });
    await toAlternatives();
    fireEvent.click(screen.getByLabelText(/2 months/i));
    clickBtn(/pause for 2 months/i);
    expect(await screen.findByRole('heading', { name: /billing is paused/i })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('manage-subscription-cancellation', {
      body: { action: 'pause', months: 2, reason: 'too_expensive', detail: 'pricey' },
    });
  });

  it('prevents double submits while an action is in flight', async () => {
    let release!: (v: Reply) => void;
    invoke.mockImplementation(async (_n: string, { body }: { body: { action: string } }) =>
      body.action === 'accept_offer' ? new Promise<Reply>((r) => (release = r)) : ok(CTX),
    );
    await toAlternatives();
    clickBtn(/claim 30% off/i);
    await waitFor(() => expect(screen.getByRole('button', { name: /claim 30% off/i })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /claim 30% off/i }));
    expect(invoke.mock.calls.filter((c) => c[1].body.action === 'accept_offer')).toHaveLength(1);
    release(ok({ ...CTX, offer: null }));
    expect(await screen.findByRole('heading', { name: /offer applied/i })).toBeInTheDocument();
  });

  it('re-syncs when the server reports the state changed under us', async () => {
    respond({ accept_offer: failure('This offer has already been used on your account.', 'offer_used') });
    await toAlternatives();
    const before = invoke.mock.calls.length;
    clickBtn(/claim 30% off/i);
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/already been used/i), 'error'));
    await waitFor(() => expect(invoke.mock.calls.length).toBeGreaterThan(before + 1));
    expect(await screen.findByRole('heading', { name: /sorry to see you go/i })).toBeInTheDocument();
  });
});

describe('CancelSubscriptionPage — confirm & cancel', () => {
  it('shows real usage and the data-export prompt before cancelling', async () => {
    fromMock.mockImplementation(() => query({ count: 42 }));
    await toConfirmStep();
    const usage = await screen.findByRole('region', { name: /your recent results/i });
    expect(within(usage).getAllByText('42').length).toBeGreaterThan(0);
    expect(screen.getByRole('region', { name: /export your data/i })).toBeInTheDocument();
  });

  it('hides the usage reminder when there is nothing to show', async () => {
    fromMock.mockImplementation(() => query({ count: 0 }));
    await toConfirmStep();
    expect(screen.queryByRole('region', { name: /your recent results/i })).not.toBeInTheDocument();
  });

  it('requires typing the confirm phrase, then schedules the cancellation', async () => {
    respond({ cancel: ok({ ...CTX, cancel_at_period_end: true, offer: null }) });
    await toConfirmStep();
    clickBtn(/^cancel subscription$/i);
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: /cancel my subscription/i });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByPlaceholderText('cancel subscription'), { target: { value: 'cancel subscription' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(await screen.findByRole('heading', { name: /your cancellation is scheduled/i })).toBeInTheDocument();
    expect(screen.getByText(/full access until november 8, 2026/i)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('manage-subscription-cancellation', {
      body: { action: 'cancel', reason: 'too_expensive', detail: '' },
    });
    // The export prompt is offered again on the success screen.
    expect(screen.getByRole('region', { name: /export your data/i })).toBeInTheDocument();
  });

  it('keeps the user on the confirm step and reports a failed cancellation', async () => {
    respond({ cancel: failure('Something went wrong. Please try again.', 'server_error') });
    await toConfirmStep();
    clickBtn(/^cancel subscription$/i);
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByPlaceholderText('cancel subscription'), { target: { value: 'cancel subscription' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel my subscription/i }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Something went wrong. Please try again.', 'error'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: /review and confirm/i })).toBeInTheDocument();
  });

  it('lets the user back out to Billing at any point', async () => {
    await toConfirmStep();
    clickBtn(/keep my subscription/i);
    expect(navigate).toHaveBeenCalledWith('/dashboard/billing');
  });
});

describe('CancelSubscriptionPage — data export', () => {
  it('downloads a CSV and confirms the row count', async () => {
    fromMock.mockImplementation(() => query({ count: 5, data: [{ name: 'A' }, { name: 'B' }] }));
    await toConfirmStep();
    clickBtn(/^customers$/i);
    await waitFor(() => expect(exportToCsv).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/downloaded 2 customers rows/i), 'success'));
  });

  it('tells the user when a list is empty instead of downloading nothing', async () => {
    fromMock.mockImplementation(() => query({ count: 0, data: [] }));
    await toConfirmStep();
    clickBtn(/^jobs$/i);
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/nothing to export/i), 'info'));
    expect(exportToCsv).not.toHaveBeenCalled();
  });
});
