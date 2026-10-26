import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const auth = {
  profile: { id: 'owner-1', company_name: 'Acme HVAC' },
  teamMember: null as { account_owner_id: string } | null,
  isOwner: true,
  permissions: { can_edit_business_profile: true, can_view_billing: true },
  loading: false,
  profileLoading: false,
};

type Result = { data: unknown; error: { message: string } | null };
let results: Record<string, Result> = {};
const ownerFilters: string[] = [];
const writes: { table: string; op: string; payload: Record<string, unknown> }[] = [];

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      let op = 'select';
      const chain: unknown = new Proxy(
        {},
        {
          get: (_t, prop: string) => {
            if (prop === 'then') {
              const key = op === 'select' ? table : `${table}:write`;
              const result = results[key] ?? { data: op === 'select' ? [] : null, error: null };
              return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
            }
            return (...args: unknown[]) => {
              if (prop === 'insert' || prop === 'update' || prop === 'delete') {
                op = prop;
                writes.push({ table, op: prop, payload: (args[0] ?? {}) as Record<string, unknown> });
              }
              if (prop === 'eq' && args[0] === 'user_id') ownerFilters.push(`${table}:${String(args[1])}`);
              return chain;
            };
          },
        },
      );
      return chain;
    },
  },
}));

import ContentCalendarPage from './ContentCalendarPage';

const tomorrowNoon = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
};
const yesterdayNoon = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
};

const row = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  user_id: 'owner-1',
  title: 'Fall tune-up promo',
  body: 'Book your tune-up',
  channel: 'facebook',
  content_type: 'post',
  status: 'scheduled',
  scheduled_at: tomorrowNoon(),
  published_at: null,
  tags: [],
  link_url: null,
  notes: null,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...over,
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/dashboard/marketing/calendar']}>
      <ContentCalendarPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  results = {};
  ownerFilters.length = 0;
  writes.length = 0;
  auth.isOwner = true;
  auth.teamMember = null;
  auth.permissions.can_edit_business_profile = true;
  auth.permissions.can_view_billing = true;
});

describe('ContentCalendarPage', () => {
  it('blocks users without business-profile access and queries nothing', async () => {
    auth.isOwner = false;
    auth.permissions.can_edit_business_profile = false;
    renderPage();
    expect(await screen.findByText(/don't have access to the Content Calendar/i)).toBeInTheDocument();
    expect(ownerFilters).toHaveLength(0);
  });

  it('shows the empty state when nothing is planned, scoped to the account owner', async () => {
    renderPage();
    expect(await screen.findByText('Your content calendar is empty')).toBeInTheDocument();
    expect(ownerFilters).toContain('content_calendar_items:owner-1');
    expect(ownerFilters).toContain('email_campaigns:owner-1');
  });

  it('scopes team members to the account owner, and skips the campaign overlay without billing access', async () => {
    auth.isOwner = false;
    auth.teamMember = { account_owner_id: 'owner-9' };
    auth.permissions.can_view_billing = false;
    renderPage();
    expect(await screen.findByText('Your content calendar is empty')).toBeInTheDocument();
    expect(ownerFilters).toContain('content_calendar_items:owner-9');
    expect(ownerFilters.some((f) => f.startsWith('email_campaigns:'))).toBe(false);
  });

  it('shows an error with a retry button when loading fails', async () => {
    results.content_calendar_items = { data: null, error: { message: 'permission denied' } };
    renderPage();
    expect(await screen.findByText('permission denied')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('lists scheduled content in the calendar', async () => {
    results.content_calendar_items = { data: [row()], error: null };
    renderPage();
    expect(await screen.findByText('Fall tune-up promo')).toBeInTheDocument();
    expect(screen.getByText('Scheduled · next 7 days')).toBeInTheDocument();
  });

  it('surfaces past-due items in "Needs attention"', async () => {
    results.content_calendar_items = { data: [row({ id: 'late', title: 'Missed post', scheduled_at: yesterdayNoon() })], error: null };
    renderPage();
    const panel = await screen.findByRole('region', { name: 'Needs attention' });
    expect(panel).toHaveTextContent('Missed post');
    expect(panel).toHaveTextContent('Past due');
  });

  it('filters by channel', async () => {
    results.content_calendar_items = {
      data: [row({ id: 'a', title: 'Facebook post' }), row({ id: 'b', title: 'Instagram reel', channel: 'instagram' })],
      error: null,
    };
    renderPage();
    expect(await screen.findByText('Facebook post')).toBeInTheDocument();
    expect(screen.getByText('Instagram reel')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Instagram' }));
    await waitFor(() => expect(screen.queryByText('Facebook post')).not.toBeInTheDocument());
    expect(screen.getByText('Instagram reel')).toBeInTheDocument();
  });

  it('validates before saving: a missing title is reported and nothing is written', async () => {
    renderPage();
    await screen.findByText('Your content calendar is empty');
    fireEvent.click(screen.getByRole('button', { name: /new content/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add to calendar' }));
    expect(await screen.findByText('Give this a title.')).toBeInTheDocument();
    expect(writes).toHaveLength(0);
  });

  it('creates content for the account owner', async () => {
    results['content_calendar_items:write'] = { data: row({ id: 'new', title: 'Spring offer', status: 'draft', scheduled_at: null }), error: null };
    renderPage();
    await screen.findByText('Your content calendar is empty');
    fireEvent.click(screen.getByRole('button', { name: /new content/i }));
    fireEvent.change(await screen.findByLabelText(/^Title/), { target: { value: 'Spring offer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to calendar' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      table: 'content_calendar_items',
      op: 'insert',
      payload: { user_id: 'owner-1', title: 'Spring offer', channel: 'facebook', status: 'draft' },
    });
  });
});
