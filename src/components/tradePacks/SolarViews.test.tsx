import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';

const api = vi.hoisted(() => ({
  fetchStages: vi.fn(), fetchEvents: vi.fn(), fetchUnits: vi.fn(), setStageStatus: vi.fn(), updateStageMeta: vi.fn(), fetchTeam: vi.fn(),
}));
vi.mock('@/lib/solarApi', async () => {
  const React = await import('react');
  return {
    fetchStages: api.fetchStages, fetchEvents: api.fetchEvents, fetchUnits: api.fetchUnits, setStageStatus: api.setStageStatus, updateStageMeta: api.updateStageMeta,
    saveUnit: vi.fn(), archiveUnit: vi.fn(), parseSerials: (s: string) => s.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean),
    friendlySolarError: (_e: unknown, fb = 'Something went wrong.') => fb,
    useAsyncData: (loader: () => Promise<unknown>, deps: unknown[]) => {
      const [state, set] = React.useState<{ data: unknown; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
      const reload = React.useCallback(async () => {
        try { set({ data: await loader(), loading: false, error: null }); } catch { set({ data: null, loading: false, error: 'Could not load.' }); }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, deps);
      React.useEffect(() => { void reload(); }, [reload]);
      return { ...state, reload };
    },
  };
});
vi.mock('@/lib/tradePacksApi', () => ({ fetchTeam: api.fetchTeam }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { SolarPipelineView } from './SolarPipelineView';
import { SolarEquipmentView } from './SolarEquipmentView';

const stage = (key: string, position: number, status = 'not_started') => ({ id: `s-${key}`, project_id: 'p1', stage_key: key, position, status, owner_id: null, due_date: null, reference_number: null, notes: null, started_at: null, submitted_at: null, decided_at: null });
const STAGES = [stage('design', 1), stage('permit', 2), stage('interconnection', 3), stage('inspection', 4), stage('pto', 5)];

beforeEach(() => {
  api.fetchStages.mockResolvedValue(STAGES);
  api.fetchEvents.mockResolvedValue([]);
  api.fetchTeam.mockResolvedValue([{ id: 't1', member_name: 'Sam' }]);
  api.fetchUnits.mockResolvedValue([]);
  api.setStageStatus.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('SolarPipelineView', () => {
  it('shows a loading state, then all five stages with dependency blocking', async () => {
    const { container } = render(<SolarPipelineView ownerId="o1" projectId="p1" jurisdiction={null} canManage />);
    expect(container.firstChild).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/1\. Design/)).toBeTruthy());
    expect(screen.getByText(/5\. Permission to operate/)).toBeTruthy();
    expect(screen.getAllByText('Waiting on earlier stage').length).toBe(4);
    expect(screen.getByText(/0\/5 stages done/)).toBeTruthy();
  });
  it('only offers legal moves and requires a reason for skip', async () => {
    render(<SolarPipelineView ownerId="o1" projectId="p1" jurisdiction={null} canManage />);
    await waitFor(() => screen.getByText(/1\. Design/));
    fireEvent.click(screen.getByRole('button', { name: 'Skipped' }));
    const confirmBtn = screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toMatch(/reason/);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Not applicable here' } });
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.setStageStatus).toHaveBeenCalledTimes(1));
    expect(api.setStageStatus.mock.calls[0][1]).toBe('skipped');
  });
  it('hides every action for read-only members', async () => {
    render(<SolarPipelineView ownerId="o1" projectId="p1" jurisdiction={null} canManage={false} />);
    await waitFor(() => screen.getByText(/1\. Design/));
    expect(screen.queryByRole('button', { name: 'In progress' })).toBeNull();
  });
  it('surfaces a load failure', async () => {
    api.fetchStages.mockRejectedValue(new Error('x'));
    render(<SolarPipelineView ownerId="o1" projectId="p1" jurisdiction={null} canManage />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Could not load/));
  });
});

describe('SolarEquipmentView', () => {
  it('shows the empty state and the warranty-convention hint', async () => {
    render(<SolarEquipmentView ownerId="o1" projectId="p1" />);
    await waitFor(() => expect(screen.getByText(/No equipment registered/)).toBeTruthy());
    expect(screen.getByText(/anniversary|start \+ years/i)).toBeTruthy();
  });
  it('renders warranty state from the unit data', async () => {
    api.fetchUnits.mockResolvedValue([{ id: 'u1', project_id: 'p1', component_kind: 'inverter', make: 'Acme', model: 'X1', quantity: 1, serials: ['S1'], installed_on: null, warranty_start: '2000-01-01', product_warranty_years: 10, performance_warranty_years: null, product_warranty_expires_on: '2009-12-31', performance_warranty_expires_on: null, warranty_expires_override: null, warranty_terms: null, status: 'active', archived_at: null }]);
    render(<SolarEquipmentView ownerId="o1" projectId="p1" />);
    await waitFor(() => expect(screen.getByText('Expired')).toBeTruthy());
    expect(screen.getByText('1 recorded')).toBeTruthy();
  });
  it('blocks saving more serials than the quantity', async () => {
    render(<SolarEquipmentView ownerId="o1" projectId="p1" />);
    await waitFor(() => screen.getByText('Add equipment'));
    fireEvent.click(screen.getByText('Add equipment'));
    fireEvent.change(screen.getByLabelText(/Serial numbers/), { target: { value: 'A, B' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/More serial numbers/));
  });
});
