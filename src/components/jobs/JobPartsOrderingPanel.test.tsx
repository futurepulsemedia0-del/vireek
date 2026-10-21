import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/truckStock', () => ({ receivePurchaseOrder: vi.fn(), setPurchaseOrderStatus: vi.fn() }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const api = vi.hoisted(() => ({
  listCart: vi.fn(),
  getJobPartsOrders: vi.fn(),
  listLocations: vi.fn(),
  searchSupplierCatalog: vi.fn(),
  addToCart: vi.fn(),
  createOrdersFromCart: vi.fn(),
  setCartQuantity: vi.fn(),
  removeFromCart: vi.fn(),
  updateShipment: vi.fn(),
}));
vi.mock('@/lib/partsOrderingApi', () => api);

import { JobPartsOrderingPanel } from './JobPartsOrderingPanel';

const job = { id: 'j1', customer_name: 'Ann Lee', job_status: 'scheduled', assigned_technician_id: 't1' };
const hit = {
  id: 'c1', vendor_id: 'v1', vendor_name: 'Acme Supply', sku: 'CAP-45', name: '45/5 capacitor', brand: null, category: null, mpn: null, uom: 'each',
  unit_cost_cents: 1250, list_price_cents: null, min_order_qty: 1, pack_size: 2, lead_time_days: 2, stock_status: 'in_stock', part_id: null,
  on_hand: 0, is_best_price: true, prev_cost_cents: null, price_changed_at: null,
};
const cartLine = {
  id: 'x', job_id: 'j1', destination_location_id: null, catalog_item_id: 'c1', quantity: 2,
  item: { vendor_id: 'v1', sku: 'CAP-45', name: 'Cap', unit_cost_cents: 1250, stock_status: 'in_stock', min_order_qty: 1, pack_size: 1, active: true, inventory_vendors: { name: 'Acme' } },
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listCart.mockResolvedValue([]);
  api.getJobPartsOrders.mockResolvedValue([]);
  api.listLocations.mockResolvedValue([{ id: 'l1', name: 'Van 1', location_type: 'van', assigned_technician_id: 't1' }]);
  api.searchSupplierCatalog.mockResolvedValue([hit]);
  api.addToCart.mockResolvedValue('cart1');
});

describe('JobPartsOrderingPanel', () => {
  it('searches the supplier catalog and shows price, stock and best-price badges', async () => {
    render(<JobPartsOrderingPanel job={job} canManage canEdit onChanged={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('Search supplier catalogs'), { target: { value: 'capacitor' } });
    expect(await screen.findByText('45/5 capacitor')).toBeInTheDocument();
    expect(screen.getByText('$12.50')).toBeInTheDocument();
    expect(screen.getByText('Best price')).toBeInTheDocument();
    expect(api.searchSupplierCatalog).toHaveBeenCalledWith('capacitor', { inStockOnly: false });
  });

  it('adds a part to the job as a requirement and refreshes the page', async () => {
    const onChanged = vi.fn();
    render(<JobPartsOrderingPanel job={job} canManage canEdit onChanged={onChanged} />);
    fireEvent.change(await screen.findByLabelText('Search supplier catalogs'), { target: { value: 'capacitor' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Add to job' }));
    await waitFor(() =>
      expect(api.addToCart).toHaveBeenCalledWith({ catalogItemId: 'c1', quantity: 1, jobId: 'j1', destinationLocationId: null, addRequirement: true }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('adds to the technician truck without creating a job requirement', async () => {
    render(<JobPartsOrderingPanel job={job} canManage canEdit onChanged={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('Search supplier catalogs'), { target: { value: 'capacitor' } });
    fireEvent.click(await screen.findByRole('button', { name: /Add to truck/ }));
    await waitFor(() => expect(api.addToCart).toHaveBeenCalledWith(expect.objectContaining({ destinationLocationId: 'l1', addRequirement: false })));
  });

  it('hides ordering controls from people who cannot manage orders', async () => {
    api.listCart.mockResolvedValue([cartLine]);
    render(<JobPartsOrderingPanel job={job} canManage={false} canEdit onChanged={vi.fn()} />);
    expect(await screen.findByText(/A manager will review this list/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create purchase order/ })).not.toBeInTheDocument();
  });

  it('creates the purchase order and holds the job by default', async () => {
    api.listCart.mockResolvedValue([cartLine]);
    api.createOrdersFromCart.mockResolvedValue({
      orders: [{ po_id: 'p', po_number: 'PO-1', vendor_id: 'v1', vendor_name: 'Acme', status: 'draft', total_cents: 2500, expected_at: '2026-10-25', line_count: 1 }],
      jobs: [{ job_id: 'j1', hold: 'ok' }],
      skipped: [],
    });
    render(<JobPartsOrderingPanel job={job} canManage canEdit onChanged={vi.fn()} />);
    expect(await screen.findByLabelText(/Put this job on/)).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Create purchase order' }));
    await waitFor(() => expect(api.createOrdersFromCart).toHaveBeenCalledWith({ jobId: 'j1', holdJob: true, notes: '' }));
  });

  it('shows an accessible error with retry when loading fails', async () => {
    api.listCart.mockRejectedValue(new Error('x'));
    render(<JobPartsOrderingPanel job={job} canManage canEdit onChanged={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load parts orders.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
