import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CallFlowsPage } from './CallFlowsPage';
import { createStarterFlow } from '@/lib/callFlows';

const OWNER_ID = 'owner-1';
const FLOW_ID = 'flow-1';

const auth = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const db = vi.hoisted(() => ({
  eqCalls: [] as [string, unknown][],
  fail: false,
  flows: [] as Record<string, unknown>[],
  flow: null as Record<string, unknown> | null,
  live: null as Record<string, unknown> | null,
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

// Chainable Supabase stub that records every .eq() so account scoping can be asserted.
vi.mock('@/lib/supabase', () => {
  const makeBuilder = (table: string) => {
    const builder: Record<string, unknown> = {};
    const one = () => {
      if (db.fail) return { data: null, error: { message: 'boom' } };
      if (table === 'call_flows') return { data: db.flow, error: null };
      if (table === 'call_flow_settings') return { data: db.live, error: null };
      if (table === 'business_profile') {
        const hours = { open: '08:00', close: '17:00', closed: false };
        return { data: { business_hours: { mon: hours, tue: hours, wed: hours, thu: hours, fri: hours }, holidays: [], assistant_name: 'Sarah' }, error: null };
      }
      return { data: null, error: null };
    };
    const many = () => {
      if (db.fail) return { data: null, error: { message: 'boom' } };
      return { data: table === 'call_flows' ? db.flows : [], error: null };
    };
    for (const m of ['select', 'order', 'limit', 'insert', 'update', 'upsert', 'delete']) builder[m] = () => builder;
    builder.eq = (col: string, val: unknown) => {
      db.eqCalls.push([`${table}.${col}`, val]);
      return builder;
    };
    builder.maybeSingle = () => Promise.resolve(one());
    builder.single = () => Promise.resolve(one());
    builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(many()).then(resolve);
    return builder;
  };
  return { supabase: { from: (table: string) => makeBuilder(table) } };
});

const ownerAuth = {
  user: { id: OWNER_ID },
  profile: { id: OWNER_ID },
  teamMember: null,
  isOwner: true,
  permissions: { can_manage_numbers: true },
  profileLoading: false,
};

const flowRow = (over: Record<string, unknown> = {}) => ({
  id: FLOW_ID,
  name: 'Main line',
  draft: createStarterFlow('UTC'),
  published: null,
  published_version: 0,
  published_at: null,
  updated_at: '2026-10-01T10:00:00.000Z',
  ...over,
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/dashboard/calls/flows" element={<CallFlowsPage />} />
        <Route path="/dashboard/calls/flows/:id" element={<CallFlowsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  auth.value = ownerAuth;
  db.eqCalls = [];
  db.fail = false;
  db.flows = [];
  db.flow = null;
  db.live = null;
});

describe('CallFlowsPage — access', () => {
  it('blocks team members without number management access', () => {
    auth.value = { ...ownerAuth, isOwner: false, teamMember: { account_owner_id: 'owner-9' }, permissions: { can_manage_numbers: false } };
    renderAt('/dashboard/calls/flows');
    expect(screen.getByText("You don't have access to this page")).toBeInTheDocument();
    expect(db.eqCalls).toHaveLength(0);
  });

  it('scopes every query to the account owner, not the signed-in team member', async () => {
    auth.value = { ...ownerAuth, isOwner: false, user: { id: 'member-1' }, profile: { id: 'member-1' }, teamMember: { account_owner_id: 'owner-9' }, permissions: { can_manage_numbers: true } };
    db.flows = [flowRow()];
    renderAt('/dashboard/calls/flows');
    expect(await screen.findByText('Main line')).toBeInTheDocument();
    expect(db.eqCalls).toContainEqual(['call_flows.account_owner_id', 'owner-9']);
    expect(db.eqCalls).toContainEqual(['call_flow_settings.account_owner_id', 'owner-9']);
    expect(db.eqCalls.some(([, v]) => v === 'member-1')).toBe(false);
  });
});

describe('CallFlowsPage — list', () => {
  it('shows the empty state with a way to create the first flow', async () => {
    renderAt('/dashboard/calls/flows');
    expect(await screen.findByText('Design your first call flow')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create a flow' }));
    expect(screen.getByLabelText('Flow name')).toBeInTheDocument();
  });

  it('shows an error state with retry when loading fails', async () => {
    db.fail = true;
    renderAt('/dashboard/calls/flows');
    expect(await screen.findByText("Couldn't load your call flows")).toBeInTheDocument();
    db.fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Design your first call flow')).toBeInTheDocument();
  });

  it('lists flows with their status and disables Make live until published', async () => {
    db.flows = [flowRow()];
    renderAt('/dashboard/calls/flows');
    expect(await screen.findByText('Main line')).toBeInTheDocument();
    expect(screen.getByText('Draft only')).toBeInTheDocument();
    expect(screen.getByText(/5 steps/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Make live/ })).toBeDisabled();
  });

  it('marks the live flow and blocks deleting it', async () => {
    db.flows = [flowRow({ published: createStarterFlow('UTC'), published_version: 2 })];
    db.live = { live_flow_id: FLOW_ID };
    renderAt('/dashboard/calls/flows');
    expect(await screen.findByText('Live')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Take offline/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Main line' })).toBeDisabled();
  });
});

describe('CallFlowsPage — builder', () => {
  it('shows a not-found state for an unknown flow', async () => {
    renderAt('/dashboard/calls/flows/missing');
    expect(await screen.findByText("This flow doesn't exist")).toBeInTheDocument();
    expect(db.eqCalls).toContainEqual(['call_flows.id', 'missing']);
  });

  it('renders the flow, opens a step in the editor and allows publishing a valid flow', async () => {
    db.flow = flowRow();
    renderAt(`/dashboard/calls/flows/${FLOW_ID}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Main line' })).toBeInTheDocument();
    expect(screen.queryByText(/to fix before publishing/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Publish$/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Save draft/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Edit step Main menu' }));
    expect(await screen.findByText('Menu step')).toBeInTheDocument();
    expect(screen.getByLabelText('What the caller hears')).toHaveValue('Thank you for calling. For service or a quote, press 1. To leave a message, press 2.');
  });

  it('creates a connected step from a connection selector and marks the draft as changed', async () => {
    db.flow = flowRow();
    renderAt(`/dashboard/calls/flows/${FLOW_ID}`);
    await screen.findByRole('heading', { level: 1, name: 'Main line' });
    expect(screen.getByText('5 of 60 steps used')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Main menu: No valid choice goes to'), { target: { value: '__new:message' } });
    await waitFor(() => expect(screen.getByText('6 of 60 steps used')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Save draft/ })).toBeEnabled();
    // The new, still-empty message step must block publishing until it is filled in.
    expect(screen.getByRole('button', { name: /^Publish$/ })).toBeDisabled();
  });

  it('lets you walk a test call with the keypad', async () => {
    db.flow = flowRow();
    renderAt(`/dashboard/calls/flows/${FLOW_ID}`);
    await screen.findByRole('heading', { level: 1, name: 'Main line' });
    // Set the test call to a weekday inside business hours.
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-10-05' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '10:00' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Press 2' }));
    expect(await screen.findByText('Caller leaves a voicemail')).toBeInTheDocument();
  });
});
