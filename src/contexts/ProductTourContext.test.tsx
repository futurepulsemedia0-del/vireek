import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductTourProvider, useProductTour } from './ProductTourContext';

vi.mock('react-i18next', async () => (await import('@/test/i18nMock')).reactI18nextMock);

const auth = vi.hoisted(() => ({ value: null as unknown }));
const api = vi.hoisted(() => ({
  records: {} as Record<string, unknown>,
  saved: [] as Array<Record<string, unknown>>,
  legacy: false,
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('@/lib/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('@/lib/gettingStartedApi', () => ({
  loadProgress: async () => ({ tourCompleted: api.legacy, checklistDismissed: false, skipped: [] }),
}));
vi.mock('@/lib/productToursApi', () => ({
  loadTourRecords: async () => ({ ...api.records }),
  saveTourRecord: async (_userId: string, rec: Record<string, unknown>) => {
    api.saved.push(rec);
  },
  deleteTipRecords: async () => undefined,
}));

const NOW = '2026-10-18T10:00:00.000Z';
const saved = (i = api.saved.length - 1) => api.saved[i];
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

const ownerAuth = () => ({
  user: { id: 'u1' },
  profile: { id: 'u1', role: 'owner', onboarding_completed: true },
  teamMember: null, isOwner: true, permissions: {}, profileLoading: false,
});
const techAuth = () => ({
  user: { id: 'u2' },
  profile: { id: 'u2', role: 'member', onboarding_completed: false },
  teamMember: { role: 'technician' }, isOwner: false, permissions: {}, profileLoading: false,
});
const record = (over: Record<string, unknown> = {}) => ({
  tourId: 'owner', version: 1, status: 'in_progress', stepIndex: 0,
  startedAt: NOW, completedAt: null, skippedAt: null, replayCount: 0, updatedAt: NOW, ...over,
});

function Probe() {
  const t = useProductTour();
  return (
    <div>
      <span data-testid="status">{t.status}</span>
      <span data-testid="tips">{String(t.tipsEnabled)}</span>
      <span data-testid="dismissed">{String(t.isTipDismissed('jobs.create'))}</span>
      <button onClick={t.startTour}>start</button>
      <button onClick={() => t.dismissTip('jobs.create')}>dismiss-tip</button>
    </div>
  );
}

function setup(path = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ProductTourProvider>
        <Probe />
      </ProductTourProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  api.records = {};
  api.saved = [];
  api.legacy = false;
  auth.value = ownerAuth();
});

describe('ProductTourProvider', () => {
  it('auto-starts the owner tour for a first-time user and persists progress', async () => {
    setup();
    expect(await screen.findByRole('dialog', { name: /welcome to vireek/i }, { timeout: 3000 })).toBeInTheDocument();
    expect(saved()).toMatchObject({ tourId: 'owner', status: 'in_progress', stepIndex: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(saved()).toMatchObject({ stepIndex: 1 });
  });

  it('skipping marks the tour skipped, enables tips, and never nags again', async () => {
    setup();
    await screen.findByRole('dialog', {}, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(saved()).toMatchObject({ status: 'skipped' });
    expect(screen.getByTestId('status')).toHaveTextContent('skipped');
    expect(screen.getByTestId('tips')).toHaveTextContent('true');
  });

  it('walking through to the end records completion', async () => {
    setup();
    await screen.findByRole('dialog', {}, { timeout: 3000 });
    for (let i = 0; i < 20; i += 1) {
      const next = screen.queryByRole('button', { name: 'Next' });
      if (!next) break;
      fireEvent.click(next);
    }
    fireEvent.click(screen.getByRole('button', { name: /open setup checklist/i }));
    expect(screen.getByTestId('status')).toHaveTextContent('completed');
    expect(saved()).toMatchObject({ status: 'completed' });
    expect(saved().completedAt).toBeTruthy();
  });

  it('pausing keeps the step and leaves the tour resumable', async () => {
    setup();
    await screen.findByRole('dialog', {}, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: /close tour/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('status')).toHaveTextContent('in_progress');
    fireEvent.click(screen.getByRole('button', { name: 'start' })); // smart start → resume
    expect(await screen.findByText(/step 2 of/i)).toBeInTheDocument();
  });

  it('offers to resume a paused tour on the next visit', async () => {
    api.records = { owner: record({ stepIndex: 2 }) };
    setup();
    expect(await screen.findByRole('region', { name: /resume product tour/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(await screen.findByText(/step 3 of/i)).toBeInTheDocument();
  });

  it('"Not now" hides the resume prompt for the session without skipping', async () => {
    api.records = { owner: record({ stepIndex: 2 }) };
    setup();
    await screen.findByRole('region', { name: /resume product tour/i });
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('region', { name: /resume product tour/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('status')).toHaveTextContent('in_progress');
  });

  it('does not auto-start when the tour was already completed', async () => {
    api.records = { owner: record({ status: 'completed', completedAt: NOW }) };
    setup();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('completed'));
    await wait(900);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('tips')).toHaveTextContent('true');
  });

  it('waits for onboarding before touring a new owner', async () => {
    auth.value = { ...ownerAuth(), profile: { id: 'u1', role: 'owner', onboarding_completed: false } };
    setup();
    await wait(1000);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('only auto-starts on the role’s entry page', async () => {
    setup('/dashboard/jobs');
    await wait(1000);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('tips')).toHaveTextContent('false'); // tour not met yet → no tips
  });

  it('treats the previous single tour as completed', async () => {
    api.legacy = true;
    setup();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('completed'));
    expect(saved()).toMatchObject({ tourId: 'owner', status: 'completed', version: 0 });
    await wait(900);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('gives technicians their own tour on the technician page', async () => {
    auth.value = techAuth();
    setup('/tech/today');
    expect(await screen.findByRole('dialog', { name: /welcome to your day/i }, { timeout: 3000 })).toBeInTheDocument();
    expect(saved()).toMatchObject({ tourId: 'technician' });
  });

  it('persists dismissed tips', async () => {
    api.records = { owner: record({ status: 'completed', completedAt: NOW }) };
    setup();
    await waitFor(() => expect(screen.getByTestId('tips')).toHaveTextContent('true'));
    fireEvent.click(screen.getByRole('button', { name: 'dismiss-tip' }));
    expect(screen.getByTestId('dismissed')).toHaveTextContent('true');
    expect(saved()).toMatchObject({ tourId: 'tip:jobs.create', status: 'completed' });
  });
});

describe('useProductTour outside the provider', () => {
  it('is inert instead of throwing', () => {
    render(<Probe />);
    expect(screen.getByTestId('status')).toHaveTextContent('not_started');
    expect(screen.getByTestId('tips')).toHaveTextContent('false');
    expect(() => fireEvent.click(screen.getByRole('button', { name: 'start' }))).not.toThrow();
  });
});
