import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn() } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'user-1' }, session: {}, loading: false }) }));

import { supabase } from '@/lib/supabase';
import { ToastProvider } from '@/contexts/ToastContext';
import { TruckStockPage } from './TruckStockPage';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

const SNAPSHOT = {
  technician_id: 't1',
  location: { id: 'l1', name: 'Van 7' },
  items: [
    { part_id: 'p1', name: 'Run capacitor 45/5', part_number: 'CAP-455', barcode: '012345678905', on_hand: 5, reserved: 0, min_quantity: 2, target_quantity: 6, requested_qty: 0 },
    { part_id: 'p2', name: 'Contactor 30A', part_number: 'CON-30', barcode: null, on_hand: 1, reserved: 0, min_quantity: 2, target_quantity: 4, requested_qty: 0 },
  ],
  jobs: [{ id: 'j1', customer_name: 'Smith residence', service_type: 'AC repair', scheduled_datetime: null, job_status: 'in_progress' }],
  vendors: [],
  catalog: [],
  generated_at: new Date().toISOString(),
};

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <TruckStockPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

beforeEach(() => {
  window.localStorage.clear();
  rpc.mockReset();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

describe('TruckStockPage', () => {
  it('shows a loading state, then the truck with low-stock parts first', async () => {
    rpc.mockResolvedValue({ data: SNAPSHOT, error: null });
    renderPage();
    expect(screen.getByRole('status', { name: /loading truck stock/i })).toBeInTheDocument();

    const list = await screen.findByRole('list');
    const names = within(list).getAllByRole('button', { name: /open actions/i }).map((b) => b.getAttribute('aria-label'));
    expect(names[0]).toMatch(/^Contactor 30A, 1 on truck, Low/);
    expect(names[1]).toMatch(/^Run capacitor 45\/5, 5 on truck, Stocked/);
    expect(screen.getByText(/Van 7 · 2 parts · 1 to restock/)).toBeInTheDocument();
  });

  it('records usage instantly (optimistic), sends it once, and uses a client op id', async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === 'get_my_truck_stock') return { data: SNAPSHOT, error: null };
      return { data: { status: 'applied' }, error: null };
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /^Run capacitor 45\/5, 5 on truck/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Quantity')).toHaveValue(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Increase quantity' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record usage' }));

    await waitFor(() => expect(rpc).toHaveBeenCalledWith('tech_use_part', expect.objectContaining({ p_part_id: 'p1', p_quantity: 2, p_job_id: 'j1' })));
    const call = rpc.mock.calls.find((c) => c[0] === 'tech_use_part');
    expect(call?.[1].p_op_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rpc.mock.calls.filter((c) => c[0] === 'tech_use_part')).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps working offline: shows the saved truck, queues the action and tells the technician', async () => {
    // Seed the device cache as if the technician had synced earlier, then lose signal.
    window.localStorage.setItem('vk:truck-stock:v1:user-1:snapshot', JSON.stringify(SNAPSHOT));
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    rpc.mockResolvedValue({ data: null, error: { message: 'Failed to fetch' } });

    renderPage();
    expect(await screen.findByText(/You're offline/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Run capacitor 45\/5, 5 on truck/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Record usage' }));

    // 5 - 1 = 4 straight away, and it is waiting to sync.
    expect(await screen.findByRole('button', { name: /^Run capacitor 45\/5, 4 on truck/ })).toBeInTheDocument();
    expect(screen.getByText(/1 waiting to sync/)).toBeInTheDocument();
    expect(rpc.mock.calls.filter((c) => c[0] === 'tech_use_part')).toHaveLength(0);
  });

  it('explains when no truck is assigned', async () => {
    rpc.mockResolvedValue({ data: { error: 'no_truck', technician_id: 't1' }, error: null });
    renderPage();
    expect(await screen.findByText('No truck assigned yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /scan part/i })).not.toBeInTheDocument();
  });

  it('shows an error with retry when nothing is cached and the server fails', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    renderPage();
    expect(await screen.findByText("Couldn't load truck stock")).toBeInTheDocument();

    rpc.mockResolvedValueOnce({ data: SNAPSHOT, error: null });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list')).toBeInTheDocument();
  });

  it('shows an empty state when the truck has no parts, and a no-match state for searches', async () => {
    rpc.mockResolvedValueOnce({ data: { ...SNAPSHOT, items: [] }, error: null });
    const first = renderPage();
    expect(await screen.findByText('Nothing on this truck yet')).toBeInTheDocument();
    first.unmount();

    window.localStorage.clear();
    rpc.mockResolvedValue({ data: SNAPSHOT, error: null });
    renderPage();
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'zzz' } });
    expect(await screen.findByText('No parts match')).toBeInTheDocument();
  });

  it('opens the use sheet when a typed barcode matches, and reports unknown codes', async () => {
    rpc.mockResolvedValue({ data: SNAPSHOT, error: null });
    renderPage();
    const search = await screen.findByRole('searchbox');

    fireEvent.change(search, { target: { value: '0012345678905' } });
    fireEvent.submit(search.closest('form')!);
    expect(await screen.findByRole('dialog')).toHaveTextContent('Run capacitor 45/5');
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);

    fireEvent.change(search, { target: { value: '5550001' } });
    fireEvent.submit(search.closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('No part matches “5550001”');
  });
});
