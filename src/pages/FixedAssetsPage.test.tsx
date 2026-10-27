import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FixedAssetsPage } from './FixedAssetsPage';
import type { FixedAsset } from '@/lib/fixedAssets';

const mocks = vi.hoisted(() => ({
  auth: {} as Record<string, unknown>,
  toast: vi.fn(),
  fetchAssets: vi.fn(),
  fetchRunPreview: vi.fn(),
  fetchForecast: vi.fn(),
  fetchChartOfAccounts: vi.fn(),
  fetchVehicleOptions: vi.fn(),
  fetchAssetEvents: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/components/DashboardNav', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/accounting', () => ({
  ensureChartOfAccounts: vi.fn(),
  fetchChartOfAccounts: mocks.fetchChartOfAccounts,
}));
vi.mock('@/lib/fixedAssets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fixedAssets')>();
  return {
    ...actual,
    fetchAssets: mocks.fetchAssets,
    fetchRunPreview: mocks.fetchRunPreview,
    fetchForecast: mocks.fetchForecast,
    fetchVehicleOptions: mocks.fetchVehicleOptions,
    fetchAssetEvents: mocks.fetchAssetEvents,
  };
});

const van: FixedAsset = {
  id: 'a1',
  asset_tag: 'FA-0001',
  name: 'Service van',
  category: 'vehicle',
  description: null,
  serial_number: null,
  location: null,
  vehicle_id: null,
  acquisition_date: '2027-01-05',
  in_service_date: '2027-01-05',
  cost_cents: 4250000,
  salvage_cents: 500000,
  useful_life_months: 60,
  method: 'straight_line',
  status: 'active',
  asset_account_id: 'acc1',
  accumulated_account_id: 'acc2',
  expense_account_id: 'acc3',
  acquisition_entry_id: null,
  disposed_on: null,
  disposal_proceeds_cents: null,
  disposal_gain_loss_cents: null,
  notes: null,
  created_at: '2027-01-05T00:00:00Z',
  accumulated_cents: 625000,
  posted_months: 10,
  scheduled_months: 50,
  next_period_start: '2027-11-01',
  next_amount_cents: 62500,
};

function setAuth(overrides: Record<string, unknown> = {}) {
  mocks.auth = {
    user: { id: 'u1' },
    profile: { id: 'u1' },
    teamMember: null,
    isOwner: true,
    permissions: { can_view_billing: true },
    ...overrides,
  };
}

describe('FixedAssetsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
    mocks.fetchAssets.mockResolvedValue([van]);
    mocks.fetchRunPreview.mockResolvedValue([]);
    mocks.fetchForecast.mockResolvedValue([]);
    mocks.fetchChartOfAccounts.mockResolvedValue([]);
    mocks.fetchVehicleOptions.mockResolvedValue([]);
    mocks.fetchAssetEvents.mockResolvedValue([]);
  });

  it('blocks team members without billing permission', () => {
    setAuth({ isOwner: false, permissions: { can_view_billing: false } });
    render(<FixedAssetsPage />);
    expect(screen.getByText("You don't have access to this page")).toBeInTheDocument();
    expect(mocks.fetchAssets).not.toHaveBeenCalled();
  });

  it('shows the register with totals and book value', async () => {
    render(<FixedAssetsPage />);
    expect(await screen.findAllByText('Service van')).not.toHaveLength(0);
    expect(screen.getAllByText('$42,500.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$36,250.00').length).toBeGreaterThan(0);
  });

  it('shows the empty state when there are no assets', async () => {
    mocks.fetchAssets.mockResolvedValue([]);
    render(<FixedAssetsPage />);
    expect(await screen.findByText('No fixed assets yet')).toBeInTheDocument();
  });

  it('shows an error state and retries', async () => {
    mocks.fetchAssets.mockRejectedValueOnce(new Error('boom'));
    render(<FixedAssetsPage />);
    expect(await screen.findByText("Couldn't load fixed assets")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again|retry/i }));
    await waitFor(() => expect(mocks.fetchAssets).toHaveBeenCalledTimes(2));
    expect((await screen.findAllByText('Service van')).length).toBeGreaterThan(0);
  });

  it('lists months waiting to be posted on the Depreciation tab', async () => {
    mocks.fetchRunPreview.mockResolvedValue([
      { period_start: '2027-09-01', period_end: '2027-09-30', asset_count: 1, total_cents: 62500, is_closed: false },
    ]);
    render(<FixedAssetsPage />);
    await screen.findAllByText('Service van');
    fireEvent.click(screen.getByRole('tab', { name: /Depreciation/ }));
    expect(await screen.findByText('Sep 2027')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Post depreciation/ })).toBeEnabled();
  });
});
