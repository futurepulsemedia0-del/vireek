import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ServiceCatalogPage } from '@/pages/ServiceCatalogPage';
import type { CatalogItem } from '@/lib/serviceCatalog';

const auth = vi.hoisted(() => ({
  value: {
    isOwner: true,
    profile: { id: 'owner-1' } as { id: string } | null,
    teamMember: null as { account_owner_id: string } | null,
    permissions: { can_view_billing: true },
    profileLoading: false,
  },
}));

const api = vi.hoisted(() => ({
  fetchCatalog: vi.fn(),
  createItem: vi.fn(),
  updateItem: vi.fn(),
  deleteItem: vi.fn(),
  setItemBookable: vi.fn(),
  createCategory: vi.fn(),
  renameCategory: vi.fn(),
  deleteCategory: vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/serviceCatalogApi', () => api);

const item = (over: Partial<CatalogItem> = {}): CatalogItem => ({
  id: 'i1',
  category_id: null,
  name: 'Drain cleaning',
  description: null,
  pricing_model: 'flat',
  price_cents: 14900,
  min_charge_cents: null,
  duration_minutes: 60,
  required_skills: ['Plumbing'],
  tax_class: 'taxable',
  bookable: true,
  ai_quote_mode: 'quote',
  ai_range_pct: 15,
  ai_max_discount_pct: 0,
  ai_price_floor_cents: null,
  ai_approval_above_cents: null,
  ai_keywords: [],
  ai_notes: null,
  sort_order: 0,
  ...over,
});

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  auth.value = {
    isOwner: true,
    profile: { id: 'owner-1' },
    teamMember: null,
    permissions: { can_view_billing: true },
    profileLoading: false,
  };
});

describe('ServiceCatalogPage', () => {
  it('blocks team members without billing permission and never loads data', () => {
    auth.value = {
      isOwner: false,
      profile: { id: 'member-1' },
      teamMember: { account_owner_id: 'owner-1' },
      permissions: { can_view_billing: false },
      profileLoading: false,
    };
    render(<ServiceCatalogPage />);
    expect(screen.getByText('Billing permission required')).toBeInTheDocument();
    expect(api.fetchCatalog).not.toHaveBeenCalled();
  });

  it("scopes the load to the account owner's id for team members", async () => {
    auth.value = {
      isOwner: false,
      profile: { id: 'member-1' },
      teamMember: { account_owner_id: 'owner-1' },
      permissions: { can_view_billing: true },
      profileLoading: false,
    };
    api.fetchCatalog.mockResolvedValue({ categories: [], items: [] });
    render(<ServiceCatalogPage />);
    await waitFor(() => expect(api.fetchCatalog).toHaveBeenCalledWith('owner-1'));
  });

  it('shows the empty state for a new catalog', async () => {
    api.fetchCatalog.mockResolvedValue({ categories: [], items: [] });
    render(<ServiceCatalogPage />);
    expect(await screen.findByText('Build your service catalog')).toBeInTheDocument();
  });

  it('shows an error state and retries', async () => {
    api.fetchCatalog.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ categories: [], items: [item()] });
    render(<ServiceCatalogPage />);
    expect(await screen.findByText("Couldn't load your catalog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Drain cleaning')).toBeInTheDocument();
  });

  it('lists services and rolls back the bookable toggle when saving fails', async () => {
    api.fetchCatalog.mockResolvedValue({ categories: [], items: [item()] });
    api.setItemBookable.mockRejectedValue({ code: '42501', message: 'rls' });
    render(<ServiceCatalogPage />);

    expect(await screen.findByText('$149')).toBeInTheDocument();
    const toggle = screen.getByRole('switch', { name: 'Bookable: Drain cleaning' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggle);
    await waitFor(() => expect(api.setItemBookable).toHaveBeenCalledWith('owner-1', 'i1', false));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Bookable: Drain cleaning' })).toHaveAttribute('aria-checked', 'true'));
  });

  it('shows a no-results state when filters match nothing and can clear them', async () => {
    api.fetchCatalog.mockResolvedValue({ categories: [], items: [item()] });
    render(<ServiceCatalogPage />);
    await screen.findByText('Drain cleaning');

    fireEvent.change(screen.getByLabelText('Search services'), { target: { value: 'zzz' } });
    expect(screen.getByText('No services match your filters')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('Drain cleaning')).toBeInTheDocument();
  });

  it('validates the editor before saving and creates a service', async () => {
    api.fetchCatalog.mockResolvedValue({ categories: [], items: [item()] });
    api.createItem.mockImplementation(async (payload: Record<string, unknown>) => ({ ...item({ id: 'i2' }), ...payload }));
    render(<ServiceCatalogPage />);
    await screen.findByText('Drain cleaning');

    fireEvent.click(screen.getByRole('button', { name: /new service/i }));
    const dialog = await screen.findByRole('dialog', { name: 'New service' });
    expect(dialog).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add service' }));
    expect(await screen.findByText(/enter a service name/i)).toBeInTheDocument();
    expect(api.createItem).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/service name/i), { target: { value: 'Water heater flush' } });
    fireEvent.change(screen.getByLabelText(/flat price/i), { target: { value: '189.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add service' }));

    await waitFor(() => expect(api.createItem).toHaveBeenCalledTimes(1));
    expect(api.createItem.mock.calls[0][0]).toMatchObject({ name: 'Water heater flush', price_cents: 18950, bookable: true });
    expect(await screen.findByText('Water heater flush')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
