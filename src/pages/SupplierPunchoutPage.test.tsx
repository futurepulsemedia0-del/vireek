import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

const parts = vi.hoisted(() => ({ listSuppliers: vi.fn(), listLocations: vi.fn() }));
vi.mock('@/lib/partsOrderingApi', () => parts);
const api = vi.hoisted(() => ({
  listConnections: vi.fn(), listSessions: vi.fn(), getSession: vi.fn(), listSessionLines: vi.fn(),
  saveConnection: vi.fn(), testConnection: vi.fn(), startSession: vi.fn(), createOrder: vi.fn(), cancelSession: vi.fn(),
}));
vi.mock('@/lib/punchoutApi', () => api);

import { SupplierPunchoutPage } from './SupplierPunchoutPage';

const conn = { id: 'c1', vendor_id: 'v1', environment: 'test', setup_url: 'https://p.example.com', buyer_domain: 'NetworkID', buyer_identity: 'b', sender_domain: 'NetworkID', sender_identity: 's', supplier_domain: 'NetworkID', supplier_identity: 'x', currency: 'USD', enabled: true, secret_set: true, last_tested_at: null, last_test_ok: null, last_test_message: null };
const returned = { id: 's1', connection_id: 'c1', vendor_id: 'v1', job_id: null, destination_location_id: null, status: 'returned', currency: 'USD', supplier_total_cents: 2500, line_count: 1, purchase_order_id: null, error_message: null, expires_at: '2030-01-01T00:00:00Z', returned_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' };
const lineRow = { id: 'l1', session_id: 's1', line_no: 1, sku: 'CAP-45', name: '45/5 capacitor', mpn: null, manufacturer: 'Acme', uom: 'each', quantity: 2, unit_price_cents: 1250, lead_time_days: null, catalog_item_id: 'k', catalog_cost_cents: 1000 };

const renderAt = (url = '/dashboard/supplier-punchout') => render(<MemoryRouter initialEntries={[url]}><SupplierPunchoutPage /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  parts.listSuppliers.mockResolvedValue([{ id: 'v1', name: 'Ferguson' }]);
  parts.listLocations.mockResolvedValue([]);
  api.listConnections.mockResolvedValue([conn]);
  api.listSessions.mockResolvedValue([]);
});

describe('SupplierPunchoutPage', () => {
  it('shows an error state with retry when loading fails', async () => {
    api.listConnections.mockRejectedValueOnce(new Error('x'));
    renderAt();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load PunchOut');
    api.listConnections.mockResolvedValue([conn]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Ferguson')).toBeInTheDocument();
  });

  it('shows the empty state when no supplier exists', async () => {
    parts.listSuppliers.mockResolvedValue([]);
    api.listConnections.mockResolvedValue([]);
    renderAt();
    expect(await screen.findByText(/Add a supplier first/)).toBeInTheDocument();
  });

  it('shows the connect prompt when a supplier has no connection yet', async () => {
    api.listConnections.mockResolvedValue([]);
    renderAt();
    expect(await screen.findByText('No PunchOut connections yet')).toBeInTheDocument();
  });

  it('shows a readable message for a failed return', async () => {
    renderAt('/dashboard/supplier-punchout?error=session_expired');
    expect(await screen.findByText(/expired or was already used/)).toBeInTheDocument();
  });

  it('reviews a returned cart with price deltas and creates the order once', async () => {
    api.getSession.mockResolvedValue(returned);
    api.listSessionLines.mockResolvedValue([lineRow]);
    api.createOrder.mockResolvedValue({ po_id: 'p', po_number: 'PO-1', status: 'draft', total_cents: 2500, line_count: 1, expected_at: '2026-02-01', job: { hold: 'not_requested' } });
    renderAt('/dashboard/supplier-punchout?session=s1');
    expect(await screen.findByText('45/5 capacitor')).toBeInTheDocument();
    expect(screen.getByText('▲ $2.50')).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /Create purchase order/ });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(await screen.findByText('Order PO-1 created')).toBeInTheDocument();
    expect(api.createOrder).toHaveBeenCalledTimes(1);
    expect(api.createOrder).toHaveBeenCalledWith({ sessionId: 's1', holdJob: false, notes: '' });
  });

  it('waits while the supplier store is open', async () => {
    api.getSession.mockResolvedValue({ ...returned, status: 'started' });
    renderAt('/dashboard/supplier-punchout?session=s1');
    await waitFor(() => expect(screen.getByText(/Waiting for you to send the cart back/)).toBeInTheDocument());
  });
});
