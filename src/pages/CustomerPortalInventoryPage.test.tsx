import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const rpc = vi.fn();
const invoke = vi.fn();
const uploadToSignedUrl = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    functions: { invoke: (...args: unknown[]) => invoke(...args) },
    storage: { from: () => ({ uploadToSignedUrl: (...args: unknown[]) => uploadToSignedUrl(...args) }) },
  },
}));
vi.mock('@/components/Header', () => ({ Header: () => <header data-testid="header" /> }));
vi.mock('@/components/Footer', () => ({ Footer: () => <footer data-testid="footer" /> }));

import { CustomerPortalInventoryPage } from './CustomerPortalInventoryPage';

const TOKEN = '3f2b8c1e-9a4d-4e7b-8c55-1a2b3c4d5e6f';

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const DATA = {
  customer: { name: 'Ana Lee' },
  business_name: 'Cool Air Co',
  summary: { item_count: 2, file_count: 1, active_warranties: 1, expiring_warranties: 0, reminders_due: 1 },
  items: [
    {
      id: 'i1', category: 'water_heating', name: 'Garage water heater', brand: 'Rheem', model: 'XE40M06', serial_number: 'RHLN1234567',
      location: 'Garage', retailer: 'Home Depot', purchase_date: '2024-03-14', purchase_price_cents: 129999, currency: 'USD',
      warranty_months: 120, warranty_expires_at: day(400), notes: null, equipment_id: 'e1', source: 'customer', created_at: '2026-01-01T00:00:00Z',
      equipment: { id: 'e1', equipment_type: 'water_heater', make: 'Rheem', model: 'XE40M06', install_date: '2024-03-20', last_service_date: '2025-04-01', service_interval_months: 12, next_service_due: day(-5), passport_code: 'ABCDEFGHJKMN' },
      files: [{ id: 'f1', kind: 'receipt', mime_type: 'image/jpeg', byte_size: 204800, original_name: 'receipt.jpg', ocr_status: 'done', created_at: '2026-01-01T00:00:00Z' }],
    },
    {
      id: 'i2', category: 'kitchen', name: 'Fridge', brand: 'LG', model: 'LRMVS', serial_number: null, location: 'Kitchen', retailer: null,
      purchase_date: null, purchase_price_cents: null, currency: 'USD', warranty_months: null, warranty_expires_at: null, notes: null,
      equipment_id: null, source: 'customer', created_at: '2026-01-02T00:00:00Z', equipment: null, files: [],
    },
  ],
  unattached_files: [],
  reminders: [
    { id: 'r1', item_id: 'i1', item_name: 'Garage water heater', kind: 'maintenance', title: 'Maintenance: Garage water heater', due_date: day(-3), interval_months: 12, status: 'active', last_completed_at: null },
  ],
  equipment_options: [{ id: 'e1', equipment_type: 'water_heater', make: 'Rheem', model: 'XE40M06' }],
};

function renderPage(token = TOKEN) {
  return render(
    <MemoryRouter initialEntries={[`/portal/${token}/inventory`]}>
      <Routes>
        <Route path="/portal/:token/inventory" element={<CustomerPortalInventoryPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  rpc.mockReset();
  invoke.mockReset();
  uploadToSignedUrl.mockReset();
  rpc.mockImplementation(async (fn: string) => (fn === 'get_portal_home_inventory' ? { data: DATA, error: null } : { data: { id: 'x' }, error: null }));
});

describe('CustomerPortalInventoryPage', () => {
  it('shows the inventory with warranty, equipment link, passport and overdue reminder', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: /my home inventory/i })).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith('get_portal_home_inventory', { p_token: TOKEN });
    expect(screen.getByText('Garage water heater', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText(/Warranty until/i)).toBeInTheDocument();
    expect(screen.getByText(/Linked to your service records: Rheem XE40M06/i)).toBeInTheDocument();
    const passport = screen.getByRole('link', { name: /view equipment passport/i });
    expect(passport).toHaveAttribute('href', '/e/ABCDEFGHJKMN');
    expect(screen.getByText(/Overdue by 3 days/i)).toBeInTheDocument();
    expect(screen.getByText(/shared with Cool Air Co/i)).toBeInTheDocument();
  });

  it('treats an invalid token as unavailable without calling the server', async () => {
    renderPage('not-a-token');
    expect(await screen.findByText(/home inventory not available/i)).toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('shows "not available" for an unknown token and a retryable error for a failure', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });
    const first = renderPage();
    expect(await first.findByText(/home inventory not available/i)).toBeInTheDocument();
    first.unmount();

    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    renderPage();
    expect(await screen.findByText(/couldn't load your home inventory/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again|retry/i }));
    expect(await screen.findByRole('heading', { name: /my home inventory/i })).toBeInTheDocument();
  });

  it('shows an empty state with a call to action when nothing has been added', async () => {
    rpc.mockResolvedValue({ data: { ...DATA, items: [], reminders: [], summary: { ...DATA.summary, item_count: 0 } }, error: null });
    renderPage();
    expect(await screen.findByText(/nothing here yet/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /add your first item/i }));
    expect(await screen.findByRole('heading', { name: /add an item/i })).toBeInTheDocument();
  });

  it('filters by search text', async () => {
    renderPage();
    await screen.findByText('Fridge', { selector: 'p' });
    fireEvent.change(screen.getByLabelText(/search your inventory/i), { target: { value: 'rheem' } });
    expect(screen.queryByText('Fridge', { selector: 'p' })).not.toBeInTheDocument();
    expect(screen.getByText('Garage water heater', { selector: 'p' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/search your inventory/i), { target: { value: 'zzz' } });
    expect(screen.getByText(/no items match/i)).toBeInTheDocument();
  });

  it('blocks saving without a name and tells the customer why', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /add item/i }));
    fireEvent.click(screen.getByRole('button', { name: /add to inventory/i }));
    expect(await screen.findByText(/give the item a name/i)).toBeInTheDocument();
    expect(rpc.mock.calls.some((c) => c[0] === 'portal_inventory_save_item')).toBe(false);
  });

  it('saves a new item through the RPC with clean values and then refreshes', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /add item/i }));
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: '  Dishwasher ' } });
    fireEvent.change(screen.getByLabelText(/^price/i), { target: { value: '499,50' } });
    fireEvent.change(screen.getByLabelText(/maintenance every/i), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: /add to inventory/i }));
    await waitFor(() => expect(rpc.mock.calls.some((c) => c[0] === 'portal_inventory_save_item')).toBe(true));
    const call = rpc.mock.calls.find((c) => c[0] === 'portal_inventory_save_item')!;
    expect(call[1]).toMatchObject({ p_token: TOKEN, p_item_id: null, p_file_ids: null });
    expect(call[1].p_fields).toMatchObject({ name: 'Dishwasher', purchase_price_cents: 49950, maintenance_interval_months: 12, source: 'customer' });
    expect(await screen.findByText(/added to your home inventory/i)).toBeInTheDocument();
    expect(rpc.mock.calls.filter((c) => c[0] === 'get_portal_home_inventory').length).toBeGreaterThan(1);
  });

  it('fills the form from a scanned receipt, marks what it read, and attaches the file on save', async () => {
    invoke
      .mockResolvedValueOnce({ data: { path: 'o/c/u.jpg', upload_token: 'tok' }, error: null })
      .mockResolvedValueOnce({
        data: {
          file: { id: 'f9', item_id: null, kind: 'receipt', mime_type: 'image/jpeg', byte_size: 4, original_name: 'r.jpg', ocr_status: 'done', created_at: '2026-10-01T00:00:00Z' },
          duplicate: false, warning: null,
          read: { source: 'document', confidence: 0.9, low_confidence: false, issues: [], manufacture_date: null, suggestion: {
            name: 'Carrier 24ACC636', category: 'hvac', brand: 'Carrier', model: '24ACC636', serial_number: null, retailer: 'Home Depot',
            purchase_date: '2024-03-14', purchase_price_cents: 499999, currency: 'USD', warranty_months: 120, warranty_expires_at: '2034-03-14' } },
        },
        error: null,
      });
    uploadToSignedUrl.mockResolvedValue({ error: null });

    const { container } = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /add item/i }));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([1, 2, 3, 4])], 'r.jpg', { type: 'image/jpeg' })] } });

    await waitFor(() => expect((screen.getByLabelText(/^name/i) as HTMLInputElement).value).toBe('Carrier 24ACC636'));
    expect((screen.getByLabelText(/^brand/i) as HTMLInputElement).value).toBe('Carrier');
    expect((screen.getByLabelText(/^price/i) as HTMLInputElement).value).toBe('4999.99');
    expect(screen.getAllByText(/read from your document, please check/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/we filled in what we could read/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /add to inventory/i }));
    await waitFor(() => expect(rpc.mock.calls.some((c) => c[0] === 'portal_inventory_save_item')).toBe(true));
    const call = rpc.mock.calls.find((c) => c[0] === 'portal_inventory_save_item')!;
    expect(call[1].p_file_ids).toEqual(['f9']);
    expect(call[1].p_fields.source).toBe('ocr');
  });

  it('shows the server message when an upload is refused and keeps the form', async () => {
    invoke.mockResolvedValueOnce({ data: null, error: { context: new Response(JSON.stringify({ error: 'Too many uploads in a short time.' }), { status: 429 }) } });
    const { container } = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /add item/i }));
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [new File([new Uint8Array([1])], 'r.jpg', { type: 'image/jpeg' })] } });
    expect(await screen.findByText(/too many uploads in a short time/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /add an item/i })).toBeInTheDocument();
  });

  it('applies reminder actions through the RPC', async () => {
    renderPage();
    const section = (await screen.findByRole('heading', { name: /^reminders$/i })).closest('section') as HTMLElement;
    fireEvent.click(within(section).getByRole('button', { name: /mark done/i }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('portal_inventory_reminder_action', { p_token: TOKEN, p_reminder_id: 'r1', p_action: 'done', p_days: null }));
    fireEvent.click(within(section).getByRole('button', { name: /snooze 30 days/i }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('portal_inventory_reminder_action', { p_token: TOKEN, p_reminder_id: 'r1', p_action: 'snooze', p_days: 30 }));
  });

  it('needs a second click to delete an item, then deletes it and its files through the function', async () => {
    invoke.mockResolvedValue({ data: { ok: true }, error: null });
    renderPage();
    const card = (await screen.findByText('Garage water heater', { selector: 'p' })).closest('li') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: /^delete$/i }));
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole('button', { name: /delete item and its files/i }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('portal-home-inventory', { body: { token: TOKEN, action: 'delete_item', itemId: 'i1' } }));
  });
});
