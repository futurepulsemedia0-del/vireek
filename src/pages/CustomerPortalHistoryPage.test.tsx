import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const rpc = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));
vi.mock('@/components/Header', () => ({ Header: () => <header data-testid="header" /> }));
vi.mock('@/components/Footer', () => ({ Footer: () => <footer data-testid="footer" /> }));

import { CustomerPortalHistoryPage } from './CustomerPortalHistoryPage';

const TOKEN = '3f2b8c1e-9a4d-4e7b-8c55-1a2b3c4d5e6f';

const FULL = {
  customer: { name: 'Ana Lee', customer_since: '2023-02-14T10:00:00Z' },
  business_name: 'Cool Air Co',
  summary: {
    completed_visits: 2,
    total_paid_cents: 25000,
    outstanding_cents: 12000,
    outstanding_count: 1,
    total_services: 2,
    total_invoices: 2,
  },
  services: [
    {
      id: 's1',
      service_type: 'AC tune-up',
      scheduled_datetime: null,
      completed_at: '2026-06-01T15:00:00',
      job_status: 'completed',
      invoice_amount: 250,
      invoice_status: 'paid',
      created_at: '2026-05-20T10:00:00',
      equipment: [{ id: 'e1', label: 'Carrier X100' }],
    },
    {
      id: 's2',
      service_type: 'Leak repair',
      scheduled_datetime: null,
      completed_at: '2025-03-03T15:00:00',
      job_status: 'completed',
      invoice_amount: null,
      invoice_status: 'not_sent',
      created_at: '2025-03-01T10:00:00',
      equipment: [],
    },
  ],
  invoices: [
    { id: 'i1', invoice_number: 'INV-0002', invoice_token: 'tok-due', status: 'sent', total_cents: 12000, due_date: '2020-01-01', sent_at: '2026-06-02T10:00:00', paid_at: null, created_at: '2026-06-02T10:00:00' },
    { id: 'i2', invoice_number: 'INV-0001', invoice_token: 'tok-paid', status: 'paid', total_cents: 25000, due_date: null, sent_at: '2026-05-21T10:00:00', paid_at: '2026-05-25T10:00:00', created_at: '2026-05-21T10:00:00' },
  ],
  memberships: [
    { id: 'm1', status: 'active', offered_at: null, started_at: '2024-01-10T10:00:00', cancelled_at: null, plan_name: 'Gold Plan', price_cents: 19900, billing_interval: 'yearly', benefits: ['Priority booking', '10% off parts'] },
  ],
  equipment: [
    { id: 'e1', equipment_type: 'AC', make: 'Carrier', model: 'X100', status: 'active', install_date: '2022-05-01', warranty_expires_at: '2099-01-01', last_service_date: '2026-06-01', service_interval_months: 12, service_count: 2 },
  ],
};

const EMPTY = {
  ...FULL,
  summary: { completed_visits: 0, total_paid_cents: 0, outstanding_cents: 0, outstanding_count: 0, total_services: 0, total_invoices: 0 },
  services: [],
  invoices: [],
  memberships: [],
  equipment: [],
};

function renderPage(path = `/portal/${TOKEN}/history`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/portal/:token/history" element={<CustomerPortalHistoryPage />} />
        <Route path="/portal/:token" element={<div>portal home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => rpc.mockReset());

describe('CustomerPortalHistoryPage', () => {
  it('shows an accessible loading state while the request is pending', () => {
    rpc.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByRole('status')).toHaveTextContent(/loading your service history/i);
  });

  it('renders summary, services grouped by year, and the back link', async () => {
    rpc.mockResolvedValue({ data: FULL, error: null });
    renderPage();
    expect(await screen.findByRole('heading', { name: /service history/i, level: 1 })).toBeInTheDocument();
    expect(screen.getByText('$250.00', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('1 unpaid invoice')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '2026' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '2025' })).toBeInTheDocument();
    expect(screen.getByText('AC tune-up')).toBeInTheDocument();
    expect(screen.getByText('Carrier X100')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to my account/i })).toHaveAttribute('href', `/portal/${TOKEN}`);
  });

  it('switches tabs, syncs ?tab=, and exposes tab semantics', async () => {
    rpc.mockResolvedValue({ data: FULL, error: null });
    renderPage();
    const invoicesTab = await screen.findByRole('tab', { name: /invoices/i });
    expect(screen.getByRole('tab', { name: /services/i })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(invoicesTab);
    expect(invoicesTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'history-tab-invoices');
  });

  it('supports arrow-key navigation between tabs', async () => {
    rpc.mockResolvedValue({ data: FULL, error: null });
    renderPage();
    const servicesTab = await screen.findByRole('tab', { name: /services/i });
    servicesTab.focus();
    fireEvent.keyDown(servicesTab, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: /invoices/i })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(screen.getByRole('tab', { name: /invoices/i }), { key: 'End' });
    expect(screen.getByRole('tab', { name: /equipment/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens on the tab from the query string and ignores junk values', async () => {
    rpc.mockResolvedValue({ data: FULL, error: null });
    const { unmount } = renderPage(`/portal/${TOKEN}/history?tab=equipment`);
    expect(await screen.findByText('Carrier X100')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /equipment/i })).toHaveAttribute('aria-selected', 'true');
    unmount();
    renderPage(`/portal/${TOKEN}/history?tab=__proto__`);
    expect(await screen.findByRole('tab', { name: /services/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('links invoices to the existing /invoice/:token page and flags overdue', async () => {
    rpc.mockResolvedValue({ data: FULL, error: null });
    renderPage(`/portal/${TOKEN}/history?tab=invoices`);
    const dueLink = await screen.findByRole('link', { name: /INV-0002/ });
    expect(dueLink).toHaveAttribute('href', '/invoice/tok-due');
    expect(within(dueLink).getByText('Overdue')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /INV-0001/ })).toHaveAttribute('href', '/invoice/tok-paid');
  });

  it('filters invoices and shows a friendly message when nothing matches', async () => {
    rpc.mockResolvedValue({ data: { ...FULL, invoices: [FULL.invoices[1]], summary: { ...FULL.summary, outstanding_count: 0, outstanding_cents: 0, total_invoices: 1 } }, error: null });
    renderPage(`/portal/${TOKEN}/history?tab=invoices`);
    fireEvent.click(await screen.findByRole('button', { name: /outstanding \(0\)/i }));
    expect(screen.getByText(/all paid up — nothing outstanding/i)).toBeInTheDocument();
  });

  it('"Review unpaid invoices" jumps to the outstanding filter', async () => {
    rpc.mockResolvedValue({ data: FULL, error: null });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /review unpaid invoices/i }));
    expect(screen.getByRole('button', { name: /outstanding/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('link', { name: /INV-0001/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /INV-0002/ })).toBeInTheDocument();
  });

  it('renders membership benefits and equipment details', async () => {
    rpc.mockResolvedValue({ data: FULL, error: null });
    const { unmount } = renderPage(`/portal/${TOKEN}/history?tab=membership`);
    expect(await screen.findByText('Gold Plan')).toBeInTheDocument();
    expect(screen.getByText(/\$199\.00 \/ year/)).toBeInTheDocument();
    expect(screen.getByText('Priority booking')).toBeInTheDocument();
    unmount();
    renderPage(`/portal/${TOKEN}/history?tab=equipment`);
    expect(await screen.findByText('Services on record')).toBeInTheDocument();
    expect(screen.getByText(/covered until/i)).toBeInTheDocument();
  });

  it('shows an empty state for every section when there is no data', async () => {
    rpc.mockResolvedValue({ data: EMPTY, error: null });
    renderPage();
    expect(await screen.findByText(/no service history yet/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /invoices/i }));
    expect(screen.getByText(/no invoices yet/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /membership/i }));
    expect(screen.getByText(/no membership on file/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /equipment/i }));
    expect(screen.getByText(/no equipment on file/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /review unpaid invoices/i })).not.toBeInTheDocument();
  });

  it('paginates long service lists with "Show more"', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...FULL.services[0], id: `s${i}`, service_type: `Visit ${i}` }));
    rpc.mockResolvedValue({ data: { ...FULL, services: many, summary: { ...FULL.summary, total_services: 20 } }, error: null });
    renderPage();
    const more = await screen.findByRole('button', { name: /show more \(5 remaining\)/i });
    expect(screen.queryByText('Visit 19')).not.toBeInTheDocument();
    fireEvent.click(more);
    expect(screen.getByText('Visit 19')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show more/i })).not.toBeInTheDocument();
  });

  it('shows "not available" (no retry) for an invalid link or disabled portal', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    renderPage();
    expect(await screen.findByRole('heading', { name: /history not available/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('does not call the backend for a malformed token', async () => {
    renderPage('/portal/not-a-uuid/history');
    expect(await screen.findByRole('heading', { name: /history not available/i })).toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('shows an error state with a working retry', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    renderPage();
    expect(await screen.findByText(/couldn't load your history/i)).toBeInTheDocument();
    rpc.mockResolvedValueOnce({ data: FULL, error: null });
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('heading', { name: /service history/i, level: 1 })).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('marks the page noindex while mounted and cleans up', async () => {
    rpc.mockResolvedValue({ data: FULL, error: null });
    const { unmount } = renderPage();
    await waitFor(() => expect(document.querySelector('meta[name="robots"][content="noindex, nofollow"]')).not.toBeNull());
    unmount();
    expect(document.querySelector('meta[name="robots"][content="noindex, nofollow"]')).toBeNull();
  });
});
