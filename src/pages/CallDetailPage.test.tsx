import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CallDetailPage } from './CallDetailPage';

const CALL_ID = '5a1c7e0e-6a55-4c0e-9d1b-0c2f6f6f0b22';
const LEAD_ID = '3f0c7e0e-6a55-4c0e-9d1b-0c2f6f6f0a11';
const OWNER_ID = 'owner-1';

const auth = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const db = vi.hoisted(() => ({
  eqCalls: [] as [string, unknown][],
  call: null as Record<string, unknown> | null,
  leads: [] as Record<string, unknown>[],
  jobs: [] as Record<string, unknown>[],
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

// Chainable Supabase stub that records every .eq() so account scoping can be asserted.
vi.mock('@/lib/supabase', () => {
  const makeBuilder = (table: string) => {
    const builder: Record<string, unknown> = {};
    const result = () => ({ data: table === 'calls' ? db.call : table === 'leads' ? db.leads : table === 'jobs' ? db.jobs : null, error: null });
    for (const m of ['select', 'order', 'limit', 'insert', 'update']) builder[m] = () => builder;
    builder.eq = (col: string, val: unknown) => {
      db.eqCalls.push([`${table}.${col}`, val]);
      return builder;
    };
    builder.maybeSingle = () => Promise.resolve(result());
    builder.single = () => Promise.resolve(result());
    builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve);
    return builder;
  };
  return { supabase: { from: (table: string) => makeBuilder(table) } };
});

const TRANSCRIPT =
  'Sarah: Thank you for calling BluePipe Plumbing.\n' +
  'Caller: Water is pouring from under my sink, I am so stressed!\n' +
  'Sarah: I am dispatching a plumber. What is your address?\n' +
  'Caller: 248 Oak Street. Thank you so much, I appreciate it.';

const baseAuth = {
  user: { id: OWNER_ID },
  profile: { id: OWNER_ID, onboarding_completed: true },
  teamMember: null,
  isOwner: true,
  permissions: { can_view_billing: true, can_view_all_jobs: true },
  loading: false,
  profileLoading: false,
};

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/dashboard/calls/:id" element={<CallDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CallDetailPage', () => {
  beforeEach(() => {
    db.eqCalls = [];
    db.leads = [];
    db.jobs = [];
    db.call = {
      id: CALL_ID,
      user_id: OWNER_ID,
      caller_name: 'Dana Whitfield',
      caller_phone: '+15551230000',
      call_datetime: '2026-10-01T10:00:00Z',
      duration_seconds: 120,
      summary: 'Burst pipe under the kitchen sink; plumber dispatched.',
      transcript: TRANSCRIPT,
      recording_url: null,
      is_emergency: true,
      is_voicemail: false,
      sentiment: 'neutral',
      status: 'booked',
      tags: [],
      lead_source: null,
      source_label: null,
      escalated_to: null,
      escalated_at: null,
      call_score: null,
      lead_score: null,
      intent: null,
      recommended_follow_up: null,
      missed_opportunity_reason: null,
      coaching_tip: null,
      objections_raised: [],
      upsell_opportunities: [],
    };
    auth.value = { ...baseAuth };
  });

  it('renders summary, transcript turns and scopes every query to the account owner', async () => {
    renderAt(`/dashboard/calls/${CALL_ID}`);
    expect(await screen.findByRole('heading', { name: 'Dana Whitfield' })).toBeInTheDocument();
    expect(screen.getByText(/Burst pipe under the kitchen sink/)).toBeInTheDocument();
    expect(screen.getAllByTestId('transcript-turn')).toHaveLength(4);
    expect(screen.getByText('This call has no recording.')).toBeInTheDocument();
    const scopes = db.eqCalls.filter(([k]) => k.endsWith('.user_id'));
    expect(scopes.length).toBeGreaterThanOrEqual(3);
    expect(scopes.every(([, v]) => v === OWNER_ID)).toBe(true);
  });

  it('scopes to the account owner for team members', async () => {
    auth.value = { ...baseAuth, user: { id: 'tech-9' }, profile: { id: 'tech-9', onboarding_completed: true }, teamMember: { account_owner_id: OWNER_ID }, isOwner: false };
    renderAt(`/dashboard/calls/${CALL_ID}`);
    await screen.findByRole('heading', { name: 'Dana Whitfield' });
    expect(db.eqCalls.filter(([k]) => k.endsWith('.user_id')).every(([, v]) => v === OWNER_ID)).toBe(true);
  });

  it('searches the transcript, counts matching turns and can filter to them', async () => {
    renderAt(`/dashboard/calls/${CALL_ID}`);
    await screen.findByRole('heading', { name: 'Dana Whitfield' });
    fireEvent.change(screen.getByLabelText('Search transcript'), { target: { value: 'thank' } });
    expect(screen.getByText('1 of 2 turns')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Next match'));
    expect(screen.getByText('2 of 2 turns')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Only matching turns'));
    expect(screen.getAllByTestId('transcript-turn')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Search transcript'), { target: { value: 'zzz' } });
    expect(screen.getByText('No matches')).toBeInTheDocument();
  });

  it('filters by speaker', async () => {
    renderAt(`/dashboard/calls/${CALL_ID}`);
    await screen.findByRole('heading', { name: 'Dana Whitfield' });
    fireEvent.change(screen.getByLabelText('Filter by speaker'), { target: { value: 'caller' } });
    expect(screen.getAllByTestId('transcript-turn')).toHaveLength(2);
  });

  it('shows the player when a recording exists and links the lead page', async () => {
    db.call = { ...(db.call as object), recording_url: 'https://example.com/rec.mp3' };
    db.leads = [{ id: LEAD_ID, name: 'Dana Whitfield', stage: 'new', customer_id: null, created_at: '2026-10-01T10:05:00Z' }];
    renderAt(`/dashboard/calls/${CALL_ID}`);
    expect(await screen.findByLabelText('Seek recording')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Dana Whitfield/ });
    expect(link).toHaveAttribute('href', `/dashboard/leads/${LEAD_ID}`);
  });

  it('shows empty states for a call without transcript or summary', async () => {
    db.call = { ...(db.call as object), transcript: null, summary: null };
    renderAt(`/dashboard/calls/${CALL_ID}`);
    expect(await screen.findByText('This call has no transcript.')).toBeInTheDocument();
    expect(screen.getByText(/no summary because the call has no transcript/i)).toBeInTheDocument();
    expect(screen.getByText('No lead linked yet.')).toBeInTheDocument();
  });

  it('blocks users without permission and never queries', async () => {
    auth.value = { ...baseAuth, isOwner: false, teamMember: { account_owner_id: OWNER_ID }, permissions: { can_view_billing: false, can_view_all_jobs: false } };
    renderAt(`/dashboard/calls/${CALL_ID}`);
    expect(await screen.findByText("You don't have access to this page")).toBeInTheDocument();
    expect(db.eqCalls).toHaveLength(0);
  });

  it('shows not-found for a missing call and a malformed id', async () => {
    db.call = null;
    const { unmount } = renderAt(`/dashboard/calls/${CALL_ID}`);
    expect(await screen.findByText('Call not found')).toBeInTheDocument();
    unmount();
    db.eqCalls = [];
    renderAt('/dashboard/calls/nope');
    await waitFor(() => expect(screen.getByText('Call not found')).toBeInTheDocument());
    expect(db.eqCalls).toHaveLength(0);
  });
});
