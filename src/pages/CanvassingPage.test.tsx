import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const auth = {
  user: { id: 'owner-1' },
  profile: { id: 'owner-1', company_name: 'Acme HVAC' },
  teamMember: null as null | { account_owner_id: string },
  isOwner: true,
  permissions: {} as Record<string, boolean>,
  loading: false,
  profileLoading: false,
};
let rpcResults: Record<string, { data: unknown; error: { message: string } | null }> = {};
let tables: Record<string, { data: unknown[]; error: { message: string } | null }> = {};
const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
const ownerFilters: string[] = [];

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/canvassing/CanvassMap', () => ({ default: () => <div data-testid="map" /> }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args?: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return Promise.resolve(rpcResults[name] ?? { data: null, error: null });
    },
    functions: { invoke: vi.fn() },
    from: (table: string) => {
      const result = tables[table] ?? { data: [], error: null };
      const chain: Record<string, unknown> = {
        select: () => chain, order: () => chain, limit: () => chain, range: () => chain,
        eq: (col: string, val: string) => { if (col === 'user_id') ownerFilters.push(`${table}:${val}`); return chain; },
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ ...result, count: result.data.length }).then(resolve),
      };
      return chain;
    },
  },
}));

import { CanvassingPage } from './CanvassingPage';

const territory = {
  id: 't1', user_id: 'owner-1', name: 'North Austin', color: '#16A34A', zip_codes: ['78701'], assigned_user_id: 'rep-1',
  assigned_at: null, status: 'active', notes: null, created_at: '2027-03-01T00:00:00Z', updated_at: '2027-03-01T00:00:00Z',
};
const baseDoor = {
  id: 'd1', user_id: 'owner-1', territory_id: 't1', line1: '100 Main St', line2: null, city: 'Austin', state: 'TX', zip: '78701', zone: '78701',
  lat: 30.27, lng: -97.74, status: 'new', visit_count: 0, last_visit_at: null, contact_name: null, contact_phone: null, contact_email: null,
  lead_id: null, follow_up_at: null, follow_up_task_id: null, created_at: '2027-03-01T00:00:00Z',
};
const ADDRESS = '100 Main St, Austin, TX 78701';

function renderPage() {
  return render(<MemoryRouter><CanvassingPage /></MemoryRouter>);
}

beforeEach(() => {
  auth.user = { id: 'owner-1' };
  auth.isOwner = true;
  auth.teamMember = null;
  auth.permissions = {};
  auth.loading = false;
  auth.profileLoading = false;
  rpcResults = { canvass_reps: { data: [{ user_id: 'rep-1', name: 'Rita Rep', role: 'member' }], error: null } };
  tables = {};
  rpcCalls.length = 0;
  ownerFilters.length = 0;
});

describe('CanvassingPage', () => {
  it('shows the empty state when there are no doors', async () => {
    renderPage();
    expect(await screen.findByText(/No doors on the map yet/i)).toBeTruthy();
  });

  it('scopes every read to the account owner, even for a team member', async () => {
    auth.isOwner = false;
    auth.user = { id: 'rep-1' };
    auth.teamMember = { account_owner_id: 'owner-9' };
    auth.permissions = {};
    renderPage();
    await screen.findByText(/No doors in your territory yet/i);
    expect(ownerFilters).toContain('canvass_doors:owner-9');
    expect(ownerFilters).toContain('canvass_territories:owner-9');
    expect(ownerFilters).not.toContain('canvass_doors:owner-1');
    expect(rpcCalls.map((c) => c.name)).not.toContain('canvass_reps');
  });

  it('shows an error state with retry when loading fails', async () => {
    tables.canvass_territories = { data: [], error: { message: 'boom' } };
    renderPage();
    expect(await screen.findByText(/Couldn't load canvassing/i)).toBeTruthy();
    tables.canvass_territories = { data: [territory], error: null };
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText(/No doors on the map yet/i)).toBeTruthy();
  });

  it('lists doors and filters them by outcome', async () => {
    tables.canvass_territories = { data: [territory], error: null };
    tables.canvass_doors = { data: [baseDoor, { ...baseDoor, id: 'd2', line1: '7 Elm Ave', status: 'sold' }], error: null };
    renderPage();
    expect(await screen.findByText(ADDRESS)).toBeTruthy();
    expect(screen.getByText('7 Elm Ave, Austin, TX 78701')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Sold/ }));
    await waitFor(() => expect(screen.queryByText(ADDRESS)).toBeNull());
    expect(screen.getByText('7 Elm Ave, Austin, TX 78701')).toBeTruthy();
  });

  it('blocks a lead-creating outcome without contact details and never calls the server', async () => {
    tables.canvass_territories = { data: [territory], error: null };
    tables.canvass_doors = { data: [baseDoor], error: null };
    renderPage();
    fireEvent.click(await screen.findByText(ADDRESS));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('radio', { name: /^Interested/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save visit' }));
    expect(await screen.findByText(/contact name is needed/i)).toBeTruthy();
    expect(rpcCalls.map((c) => c.name)).not.toContain('canvass_visit_log');
  });

  it('saves a visit with the contact details and updates the door', async () => {
    tables.canvass_territories = { data: [territory], error: null };
    tables.canvass_doors = { data: [baseDoor], error: null };
    rpcResults.canvass_visit_log = {
      data: { door: { ...baseDoor, status: 'interested', visit_count: 1, contact_name: 'Jane Doe', lead_id: 'l1' }, visit_id: 'v1', lead_id: 'l1', task_id: null, duplicate: false },
      error: null,
    };
    renderPage();
    fireEvent.click(await screen.findByText(ADDRESS));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('radio', { name: /^Interested/ }));
    fireEvent.change(screen.getByLabelText(/Contact name/), { target: { value: 'Jane Doe' } });
    fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: '(512) 555-0100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save visit' }));
    await waitFor(() => expect(rpcCalls.some((c) => c.name === 'canvass_visit_log')).toBe(true));
    const call = rpcCalls.find((c) => c.name === 'canvass_visit_log');
    expect(call?.args).toMatchObject({ p_door_id: 'd1', p_outcome: 'interested', p_contact_name: 'Jane Doe', p_contact_phone: '(512) 555-0100' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('locks Do Not Knock doors for reps', async () => {
    auth.isOwner = false;
    auth.user = { id: 'rep-1' };
    auth.teamMember = { account_owner_id: 'owner-1' };
    tables.canvass_territories = { data: [territory], error: null };
    tables.canvass_doors = { data: [{ ...baseDoor, status: 'do_not_knock' }], error: null };
    renderPage();
    fireEvent.click(await screen.findByText(ADDRESS));
    expect(await screen.findByText(/Do not visit/i)).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /^Interested/ })).toBeNull();
  });

  it('lists overdue follow-ups and marks one done', async () => {
    tables.canvass_territories = { data: [territory], error: null };
    tables.canvass_doors = { data: [{ ...baseDoor, status: 'callback', follow_up_at: '2020-01-01T10:00:00Z', follow_up_task_id: 'k1' }], error: null };
    rpcResults.canvass_followup_done = { data: { ...baseDoor, status: 'callback', follow_up_at: null, follow_up_task_id: null }, error: null };
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: /Follow-ups/ }));
    expect(await screen.findByText('Overdue')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Mark follow-up at 100 Main St as done/ }));
    await waitFor(() => expect(rpcCalls.some((c) => c.name === 'canvass_followup_done')).toBe(true));
    expect(await screen.findByText(/No follow-ups scheduled/i)).toBeTruthy();
  });

  it('lets managers create a territory but not reps', async () => {
    renderPage();
    await screen.findByText(/No doors on the map yet/i);
    fireEvent.click(screen.getByRole('tab', { name: 'Territories' }));
    expect(await screen.findByText(/No territories yet/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Create territory/i })).toBeTruthy();
  });

  it('shows rep-friendly copy when no territory is assigned', async () => {
    auth.isOwner = false;
    auth.user = { id: 'rep-1' };
    auth.teamMember = { account_owner_id: 'owner-1' };
    renderPage();
    await screen.findByText(/No doors in your territory yet/i);
    fireEvent.click(screen.getByRole('tab', { name: 'Territories' }));
    expect(await screen.findByText(/No territory assigned yet/i)).toBeTruthy();
  });
});
