import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LeadDetailPage } from './LeadDetailPage';

const LEAD_ID = '3f0c7e0e-6a55-4c0e-9d1b-0c2f6f6f0a11';
const OWNER_ID = 'owner-1';

const auth = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));
const queries = vi.hoisted(() => ({ eqCalls: [] as [string, unknown][], leadRow: null as Record<string, unknown> | null }));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/activityLedger', () => ({ fetchAggregateHistory: vi.fn().mockResolvedValue([]) }));

// Minimal chainable Supabase stub: records every .eq() so scoping can be asserted.
vi.mock('@/lib/supabase', () => {
  const makeBuilder = (table: string) => {
    const builder: Record<string, unknown> = {};
    const result = () => ({ data: table === 'leads' ? queries.leadRow : table === 'quotes' || table === 'jobs' || table === 'marketing_attribution_touches' ? [] : null, error: null });
    for (const m of ['select', 'order', 'limit', 'insert', 'update']) builder[m] = () => builder;
    builder.eq = (col: string, val: unknown) => {
      queries.eqCalls.push([`${table}.${col}`, val]);
      return builder;
    };
    builder.maybeSingle = () => Promise.resolve(result());
    builder.single = () => Promise.resolve(result());
    builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve);
    return builder;
  };
  return { supabase: { from: (table: string) => makeBuilder(table) } };
});

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
        <Route path="/dashboard/leads/:id" element={<LeadDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('LeadDetailPage', () => {
  beforeEach(() => {
    queries.eqCalls = [];
    queries.leadRow = {
      id: LEAD_ID,
      user_id: OWNER_ID,
      call_id: null,
      customer_id: null,
      name: 'Dana Whitfield',
      phone: null,
      email: null,
      service_interested: 'AC repair',
      notes: null,
      stage: 'new',
      quote_amount: null,
      quote_sent_at: null,
      follow_up_count: 0,
      last_follow_up_at: null,
      created_at: '2026-10-01T10:00:00Z',
    };
    auth.value = { ...baseAuth };
  });

  it('renders the lead and scopes every query to the account owner', async () => {
    renderAt(`/dashboard/leads/${LEAD_ID}`);
    expect(await screen.findByRole('heading', { name: 'Dana Whitfield' })).toBeInTheDocument();
    expect(screen.getByText('Not scored yet.', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Unattributed')).toBeInTheDocument();
    const userScopes = queries.eqCalls.filter(([k]) => k.endsWith('.user_id'));
    expect(userScopes.length).toBeGreaterThan(3);
    expect(userScopes.every(([, v]) => v === OWNER_ID)).toBe(true);
  });

  it('scopes to the account owner (not the signed-in id) for team members', async () => {
    auth.value = {
      ...baseAuth,
      user: { id: 'tech-9' },
      profile: { id: 'tech-9', onboarding_completed: true },
      teamMember: { account_owner_id: OWNER_ID },
      isOwner: false,
    };
    renderAt(`/dashboard/leads/${LEAD_ID}`);
    await screen.findByRole('heading', { name: 'Dana Whitfield' });
    expect(queries.eqCalls.filter(([k]) => k.endsWith('.user_id')).every(([, v]) => v === OWNER_ID)).toBe(true);
  });

  it('blocks users without the required permission and never queries', async () => {
    auth.value = { ...baseAuth, isOwner: false, teamMember: { account_owner_id: OWNER_ID }, permissions: { can_view_billing: false, can_view_all_jobs: false } };
    renderAt(`/dashboard/leads/${LEAD_ID}`);
    expect(await screen.findByText("You don't have access to this page")).toBeInTheDocument();
    expect(queries.eqCalls).toHaveLength(0);
  });

  it('shows not-found for a missing lead and for a malformed id', async () => {
    queries.leadRow = null;
    const { unmount } = renderAt(`/dashboard/leads/${LEAD_ID}`);
    expect(await screen.findByText('Lead not found')).toBeInTheDocument();
    unmount();
    queries.eqCalls = [];
    renderAt('/dashboard/leads/not-a-uuid');
    await waitFor(() => expect(screen.getByText('Lead not found')).toBeInTheDocument());
    expect(queries.eqCalls).toHaveLength(0);
  });

  it('hides conversion controls from view-only users', async () => {
    auth.value = { ...baseAuth, isOwner: false, teamMember: { account_owner_id: OWNER_ID }, permissions: { can_view_billing: false, can_view_all_jobs: true } };
    renderAt(`/dashboard/leads/${LEAD_ID}`);
    await screen.findByRole('heading', { name: 'Dana Whitfield' });
    expect(screen.queryByRole('button', { name: /convert to customer/i })).not.toBeInTheDocument();
    expect(screen.getByText(/only the account owner can convert/i)).toBeInTheDocument();
  });
});
