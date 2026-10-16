import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const auth = {
  profile: { id: 'owner-1', company_name: 'Acme HVAC' },
  teamMember: null,
  isOwner: true,
  permissions: { can_view_billing: true },
  loading: false,
  profileLoading: false,
};
let tables: Record<string, { data: unknown[]; error: { message: string } | null }> = {};
const seenOwnerFilters: string[] = [];

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const result = tables[table] ?? { data: [], error: null };
      const chain: Record<string, unknown> = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        eq: (col: string, val: string) => {
          if (col === 'user_id') seenOwnerFilters.push(`${table}:${val}`);
          return chain;
        },
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
      };
      return chain;
    },
    functions: { invoke: vi.fn() },
  },
}));

import EmailCampaignsPage from './EmailCampaignsPage';

const campaign = {
  id: 'c1', user_id: 'owner-1', name: 'Fall tune-up', subject: 'Book your tune-up', preheader: null, body: 'Hi', from_name: null,
  reply_to: null, sender_address: '1 Main St', audience: 'all_opted_in', segment_id: null, status: 'sent', scheduled_at: null,
  started_at: '2026-10-01T10:00:00Z', completed_at: '2026-10-01T10:05:00Z', recipient_count: 200, sent_count: 200, failed_count: 0,
  delivered_count: 198, bounce_count: 2, unique_opens: 80, unique_clicks: 20, unsubscribe_count: 1, last_error: null,
  created_at: '2026-10-01T09:00:00Z', updated_at: '2026-10-01T10:05:00Z',
};

beforeEach(() => {
  tables = {};
  seenOwnerFilters.length = 0;
  auth.isOwner = true;
  auth.permissions.can_view_billing = true;
});

describe('EmailCampaignsPage', () => {
  it('blocks users without billing access (permission gate) and queries nothing', async () => {
    auth.isOwner = false;
    auth.permissions.can_view_billing = false;
    render(<EmailCampaignsPage />);
    expect(await screen.findByText(/don't have access to Email Campaigns/i)).toBeInTheDocument();
    expect(seenOwnerFilters).toHaveLength(0);
  });

  it('shows the empty state when there are no campaigns, scoped to the account owner', async () => {
    render(<EmailCampaignsPage />);
    expect(await screen.findByText('No campaigns yet')).toBeInTheDocument();
    expect(seenOwnerFilters).toContain('email_campaigns:owner-1');
    expect(seenOwnerFilters).toContain('email_templates:owner-1');
    expect(seenOwnerFilters).toContain('marketing_segments:owner-1');
  });

  it('lists campaigns with real stats', async () => {
    tables.email_campaigns = { data: [campaign], error: null };
    render(<EmailCampaignsPage />);
    expect(await screen.findByText('Fall tune-up')).toBeInTheDocument();
    expect(screen.getByText('Sent', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument(); // 80 / 200 opened
    expect(screen.getByText('10%')).toBeInTheDocument(); // 20 / 200 clicked
  });

  it('shows an error state with retry when loading fails', async () => {
    tables.email_campaigns = { data: [], error: { message: 'relation "email_campaigns" does not exist' } };
    render(<EmailCampaignsPage />);
    await waitFor(() => expect(screen.getByText(/does not exist/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
