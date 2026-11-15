import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { computeKnowledge } from '@/lib/sarahKnowledge';
import type { LearnField, LearnRun } from '@/pages/onboarding/sarah/sarahLearnLogic';
import { SarahKnowledgeCard } from './SarahKnowledgeCard';

// ---- mocks -----------------------------------------------------------------
const auth = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const hook = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const api = vi.hoisted(() => ({ interview: vi.fn(), track: vi.fn() }));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('./useSarahKnowledge', () => ({ useSarahKnowledge: () => hook.value }));
vi.mock('./sarahHubI18n', () => ({ HUB_NS: 'sarahHub' }));
vi.mock('@/components/sarah/SarahOrb', () => ({ SarahOrb: () => <span data-testid="orb" /> }));
vi.mock('@/components/loading', () => ({ SkeletonBlock: () => <div data-testid="skeleton" /> }));
vi.mock('@/pages/onboarding/sarah/sarahLearnApi', () => {
  class ApiError extends Error {}
  return { ApiError, interview: api.interview, track: api.track };
});
vi.mock('react-i18next', async () => {
  const en = (await import('@/locales/en/sarahHub.json')).default as Record<string, unknown>;
  const get = (key: string): string => {
    const v = key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en);
    return typeof v === 'string' ? v : key;
  };
  const t = (key: string, vars: Record<string, unknown> = {}) => get(key).replace(/{{\s*(\w+)\s*}}/g, (_, k: string) => String(vars[k] ?? ''));
  return { useTranslation: () => ({ t, i18n: { language: 'en' } }) };
});

// ---- fixtures --------------------------------------------------------------
const run = (over: Partial<LearnRun> = {}): LearnRun => ({
  id: 'run-1', status: 'interviewing', locale: 'en', website_url: 'https://acme.com', started_at: '2030-01-01T00:00:00Z',
  first_draft_at: null, readiness_passed: false, readiness_score: null, test_call_confirmed_at: null, live_at: null, ...over,
});
const field = (key: string, over: Partial<LearnField> = {}): LearnField => ({
  id: `f-${key}`, key, value: 'x', prev_value: null, confidence: 'high', assumed: false, sensitive: false, origin: 'source',
  source_id: null, citation: null, status: 'approved', edit_count: 0, ...over,
});

const setHook = (status: string, r: LearnRun | null, fields: LearnField[], refresh = vi.fn()) => {
  hook.value = { status, run: r, snapshot: computeKnowledge(r, fields), refresh };
  return refresh;
};
const setAuth = (over: Record<string, unknown> = {}) => {
  auth.value = { user: { id: 'u1' }, isOwner: true, permissions: { can_edit_business_profile: true }, ...over };
};

function Probe() {
  const l = useLocation();
  return <div data-testid="loc">{l.pathname + l.search}</div>;
}
const renderCard = () =>
  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Routes>
        <Route path="*" element={<><SarahKnowledgeCard /><Probe /></>} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  window.localStorage.clear();
  api.interview.mockReset();
  api.track.mockReset();
  setAuth();
});
afterEach(cleanup);

describe('SarahKnowledgeCard', () => {
  it('renders nothing for people who cannot edit the business profile', () => {
    setAuth({ isOwner: false, permissions: { can_edit_business_profile: false } });
    setHook('ready', null, []);
    const { container } = renderCard();
    expect(container.querySelector('[data-testid="sarah-knowledge-card"]')).toBeNull();
  });

  it('shows a skeleton while loading and a retryable error if loading fails', () => {
    setHook('loading', null, []);
    renderCard();
    expect(screen.getByTestId('skeleton')).toBeInTheDocument();
    cleanup();
    const refresh = setHook('error', null, []);
    renderCard();
    expect(screen.getByRole('alert')).toHaveTextContent("We couldn't load Sarah's status.");
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refresh).toHaveBeenCalledWith(false);
  });

  it('not started: rejects a bad website, hands a good one to the hub', () => {
    setHook('ready', null, []);
    renderCard();
    expect(screen.getByTestId('sarah-knowledge-card')).toHaveAttribute('data-stage', 'not_started');
    const input = screen.getByLabelText('Your website');
    const submit = screen.getByRole('button', { name: 'Let Sarah read it' });
    expect(submit).toBeDisabled();

    fireEvent.change(input, { target: { value: 'not a url' } });
    fireEvent.click(submit);
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid website');
    expect(screen.getByTestId('loc')).toHaveTextContent('/dashboard');

    fireEvent.change(input, { target: { value: 'acme-plumbing.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Let Sarah read it' }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/dashboard/sarah?website=https%3A%2F%2Facme-plumbing.com%2F');
  });

  it('learning: shows the score and answers one question inline without leaving the dashboard', async () => {
    const refresh = setHook('ready', run(), [field('business_name'), field('hours', { status: 'pending' })]);
    api.interview
      .mockResolvedValueOnce({ question: { id: 'q1', key: 'diagnostic_fee', text: 'Do you charge a diagnostic fee?', choices: [{ value: 'No fee', label: 'No fee' }] }, remaining: 3, answered: 0, max_questions: 7, estimate_seconds: 30, done: false })
      .mockResolvedValueOnce({ question: null, remaining: 0, answered: 1, max_questions: 7, estimate_seconds: 0, done: true });
    renderCard();

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow');
    fireEvent.click(screen.getByRole('button', { name: 'Answer a quick question' }));
    expect(await screen.findByText('Do you charge a diagnostic fee?')).toBeInTheDocument();
    expect(api.interview).toHaveBeenCalledWith('run-1', 'next', undefined, undefined);

    fireEvent.click(screen.getByRole('button', { name: 'No fee' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    await waitFor(() => expect(api.interview).toHaveBeenCalledWith('run-1', 'answer', 'q1', 'No fee'));
    expect(await screen.findByText("That's everything Sarah needed for now.")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledWith(true);
    expect(screen.getByTestId('loc')).toHaveTextContent('/dashboard');
  });

  it('shows the server error instead of failing silently when a question cannot be loaded', async () => {
    setHook('ready', run(), [field('business_name')]);
    api.interview.mockRejectedValueOnce(new Error('boom'));
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Answer a quick question' }));
    expect(await screen.findByText("We couldn't load the question. Please try again.")).toBeInTheDocument();
  });

  it('"Not now" collapses the card for a day and remembers it per user', () => {
    setHook('ready', run(), [field('business_name')]);
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    const stored = Number(window.localStorage.getItem('vireek.sarahKnowledge.snoozedUntil.u1'));
    expect(stored).toBeGreaterThan(Date.now() + 23 * 3600 * 1000);
    expect(screen.getByTestId('sarah-knowledge-card')).toHaveAttribute('data-snoozed', 'true');
    expect(screen.getByRole('link', { name: 'Continue' })).toHaveAttribute('href', '/dashboard/sarah');
  });

  it('live with gaps: compact line linking to the hub; live and complete: renders nothing', () => {
    setHook('ready', run({ status: 'live', live_at: '2030-01-02T00:00:00Z' }), [field('business_name')]);
    renderCard();
    expect(screen.getByTestId('sarah-knowledge-card')).toHaveAttribute('data-stage', 'live');
    expect(screen.getByRole('link', { name: 'Improve Sarah' })).toHaveAttribute('href', '/dashboard/sarah');
    cleanup();

    const all = ['business_name', 'trade', 'languages', 'services_offered', 'services_not_offered', 'never_book', 'differentiators', 'service_area', 'service_area_notes', 'hours', 'holiday_hours', 'emergency_policy', 'pricing_signals', 'diagnostic_fee', 'financing', 'licenses_insurance', 'warranties', 'escalation_contact', 'brand_pronunciation', 'team_names', 'tone_samples', 'tone_preference', 'faqs'].map((k) => field(k));
    setHook('ready', run({ status: 'live', live_at: '2030-01-02T00:00:00Z' }), all);
    const { container } = renderCard();
    expect(container.querySelector('[data-testid="sarah-knowledge-card"]')).toBeNull();
  });
});
