import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const auth = {
  profile: { id: 'owner-1', company_name: 'Acme HVAC' },
  teamMember: null as null | { account_owner_id: string },
  isOwner: true,
  permissions: { can_view_billing: true } as Record<string, boolean>,
  loading: false,
  profileLoading: false,
};
let rpcResults: Record<string, { data: unknown; error: { message: string } | null }> = {};
let tables: Record<string, { data: unknown[]; error: { message: string } | null }> = {};
const rpcCalls: string[] = [];
const ownerFilters: string[] = [];

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string) => {
      rpcCalls.push(name);
      return Promise.resolve(rpcResults[name] ?? { data: null, error: null });
    },
    functions: { invoke: vi.fn() },
    from: (table: string) => {
      const result = tables[table] ?? { data: [], error: null };
      const chain: Record<string, unknown> = {
        select: () => chain, order: () => chain, limit: () => chain, not: () => chain, range: () => chain,
        eq: (col: string, val: string) => { if (col === 'user_id') ownerFilters.push(`${table}:${val}`); return chain; },
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ ...result, count: result.data.length }).then(resolve),
      };
      return chain;
    },
  },
}));

import { DirectMailPage } from './DirectMailPage';

const settings = {
  configured: true, api_mode: 'test', api_key_last4: 'ab12', webhook_secret_set: false, webhook_token: 'a'.repeat(64),
  return_address: { name: 'Acme HVAC', line1: '1 Main St', line2: null, city: 'Austin', state: 'TX', zip: '78701' }, default_landing_page_id: null,
};
const reportRow = {
  campaign_id: 'c1', name: 'Spring tune-up', status: 'completed', size: '6x9', created_at: '2027-03-01T00:00:00Z', sent_at: null,
  pieces_total: 1000, queued: 0, in_mail: 0, delivered: 950, returned: 0, failed: 0, mailed: 1000, cost_cents: 85000,
  cost_estimated_pieces: 0, scanned_pieces: 60, scans: 80, landing_views: 70, landing_visitors: 55, leads: 25, responders: 30,
  booked_jobs: 17, completed_jobs: 12, revenue: 5400,
};

beforeEach(() => {
  auth.isOwner = true;
  auth.teamMember = null;
  auth.permissions = { can_view_billing: true };
  auth.loading = false;
  auth.profileLoading = false;
  rpcResults = { direct_mail_settings_get: { data: settings, error: null }, direct_mail_report: { data: [reportRow], error: null } };
  tables = {};
  rpcCalls.length = 0;
  ownerFilters.length = 0;
});

describe('DirectMailPage', () => {
  it('blocks team members without billing access and never queries data', async () => {
    auth.isOwner = false;
    auth.teamMember = { account_owner_id: 'owner-1' };
    auth.permissions = { can_view_billing: false };
    render(<DirectMailPage />);
    expect(await screen.findByText(/limited to account managers/i)).toBeTruthy();
    expect(rpcCalls).toHaveLength(0);
  });

  it('shows the empty state when there are no campaigns', async () => {
    render(<DirectMailPage />);
    expect(await screen.findByText(/No postcard campaigns yet/i)).toBeTruthy();
  });

  it('scopes campaign reads to the account owner, even for a team member', async () => {
    auth.isOwner = false;
    auth.teamMember = { account_owner_id: 'owner-9' };
    auth.permissions = { can_view_billing: true };
    render(<DirectMailPage />);
    await screen.findByText(/No postcard campaigns yet/i);
    expect(ownerFilters).toContain('direct_mail_campaigns:owner-9');
    expect(ownerFilters).not.toContain('direct_mail_campaigns:owner-1');
  });

  it('shows an error state with retry when settings fail to load', async () => {
    rpcResults.direct_mail_settings_get = { data: null, error: { message: 'boom' } };
    render(<DirectMailPage />);
    expect(await screen.findByText(/Couldn't load direct mail/i)).toBeTruthy();
    rpcResults.direct_mail_settings_get = { data: settings, error: null };
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText(/No postcard campaigns yet/i)).toBeTruthy();
  });

  it('lists campaigns', async () => {
    tables.direct_mail_campaigns = { data: [{ id: 'c1', name: 'Spring tune-up', status: 'draft', headline: 'Beat the heat', created_at: '2027-03-01T00:00:00Z' }], error: null };
    render(<DirectMailPage />);
    expect(await screen.findByText('Spring tune-up')).toBeTruthy();
    expect(screen.getByText('Draft')).toBeTruthy();
  });

  it('shows cost per booked job in Results', async () => {
    render(<DirectMailPage />);
    await screen.findByText(/No postcard campaigns yet/i);
    fireEvent.click(screen.getByRole('tab', { name: 'Results' }));
    expect(await screen.findByText('Cost per booked job')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('$50').length).toBeGreaterThan(0));
    expect(rpcCalls).toContain('direct_mail_report');
  });

  it('warns that test mode never mails anything', async () => {
    render(<DirectMailPage />);
    await screen.findByText(/No postcard campaigns yet/i);
    fireEvent.click(screen.getByRole('tab', { name: 'Setup' }));
    expect(await screen.findByText(/nothing is printed or mailed/i)).toBeTruthy();
    expect(screen.getByText(/not set — delivery status will not update/i)).toBeTruthy();
  });
});
