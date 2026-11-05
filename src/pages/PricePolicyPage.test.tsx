import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PricePolicyPage } from './PricePolicyPage';
import en from '@/locales/en/pricePolicy.json';
import { DEFAULT_PLAYBOOK_SETTINGS } from '../../supabase/functions/_shared/price-playbook/engine';
import type { PricePolicyRecord } from '@/lib/pricePolicy';

const api = vi.hoisted(() => ({
  METRICS_WINDOW_DAYS: 30,
  fetchPolicies: vi.fn(),
  fetchBookItems: vi.fn(),
  fetchPlaybookSettings: vi.fn(),
  fetchOwnerId: vi.fn(),
  fetchMetrics: vi.fn(),
  savePolicy: vi.fn(),
  savePlaybookSettings: vi.fn(),
  deletePolicy: vi.fn(),
  setPolicyActive: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('@/lib/pricePolicyApi', () => api);
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
// Real English strings from the shipped locale file, with {{var}} interpolation.
vi.mock('@/i18n/pricePolicyNamespace', () => ({
  usePricePolicyT: () => ({
    language: 'en',
    t: (key: string, vars?: Record<string, unknown>) => {
      const v = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], en);
      return typeof v === 'string' ? v.replace(/\{\{(\w+)\}\}/g, (_m, n) => String(vars?.[n] ?? '')) : key;
    },
  }),
}));

const REC: PricePolicyRecord = {
  id: 'p1', user_id: 'o1', service_key: 'ac_repair', display_name: 'AC repair', trade: 'hvac', mode: 'range', source_kind: 'owner_entered',
  price_book_item_id: null, keywords: [], amount_low_cents: 20000, amount_high_cents: 40000, diagnostic_fee_cents: 8900,
  fee_credited_on_repair: true, written_price_before_work: false, includes: ['labor'], changes_price: [], verified_at: new Date().toISOString(),
  approved_states: ['TX'], legal_review_status: 'approved', active: true, created_at: '', updated_at: '',
};

function setup(over: Record<string, unknown> = {}) {
  auth.value = { isOwner: true, permissions: {}, ...over };
  return render(<MemoryRouter><PricePolicyPage /></MemoryRouter>);
}

describe('PricePolicyPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchPolicies.mockResolvedValue([REC]);
    api.fetchBookItems.mockResolvedValue([]);
    api.fetchPlaybookSettings.mockResolvedValue(DEFAULT_PLAYBOOK_SETTINGS);
    api.fetchOwnerId.mockResolvedValue('o1');
    api.fetchMetrics.mockResolvedValue({ metrics: { conversations_with_price_ask: 4, price_ask_rate: 0.2, conversion_after_price: 0.5, abandon_rate: 0.25, average_ticket_cents: 40000 }, truncated: false });
    api.savePolicy.mockResolvedValue(undefined);
    api.savePlaybookSettings.mockResolvedValue(undefined);
  });

  it('blocks users without billing permission and never loads data', async () => {
    setup({ isOwner: false, permissions: { can_view_billing: false } });
    expect(await screen.findByText(en.page.noPermission)).toBeTruthy();
    expect(api.fetchPolicies).not.toHaveBeenCalled();
  });

  it('lists policies with metrics and the legal banner', async () => {
    setup();
    expect(await screen.findByText('AC repair')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toContain('not legal advice');
    expect(await screen.findByText('20%')).toBeTruthy();
    expect(screen.getByText('$400')).toBeTruthy();
  });

  it('shows a retry state when loading fails', async () => {
    api.fetchPolicies.mockRejectedValue(new Error('x'));
    setup();
    fireEvent.click(await screen.findByText(en.page.retry));
    await waitFor(() => expect(api.fetchPolicies).toHaveBeenCalledTimes(2));
  });

  it('shows the empty state with a CTA when there are no policies', async () => {
    api.fetchPolicies.mockResolvedValue([]);
    setup();
    expect(await screen.findByText(en.page.emptyTitle)).toBeTruthy();
  });

  it('warns when a policy awaits legal review', async () => {
    api.fetchPolicies.mockResolvedValue([{ ...REC, legal_review_status: 'pending' }]);
    setup();
    expect(await screen.findByText(en.warnings.pending_review)).toBeTruthy();
  });

  it('previews the fail-closed answer for an unknown state, and the real answer for an approved one', async () => {
    setup();
    fireEvent.click(await screen.findByText(en.form.edit));
    expect(await screen.findByText(en.downgrade.region_unknown)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(en.page.previewState), { target: { value: 'TX' } });
    await waitFor(() => expect(screen.queryByText(en.downgrade.region_unknown)).toBeNull());
    expect(screen.getByText(/\$200 and \$400/)).toBeTruthy();
    expect(screen.getByText(new RegExp(en.page.auditPass.slice(0, 20)))).toBeTruthy();
  });

  it('shows a translated validation error and does not save invalid input', async () => {
    setup();
    fireEvent.click(await screen.findByText(en.form.edit));
    fireEvent.change(await screen.findByLabelText(new RegExp(en.form.name)), { target: { value: '' } });
    fireEvent.click(screen.getByText(en.form.save));
    expect((await screen.findByRole('alert')).textContent).toBe(en.errors.name_required);
    expect(api.savePolicy).not.toHaveBeenCalled();
  });

  it('saves a valid policy under the owner id and reloads', async () => {
    setup();
    fireEvent.click(await screen.findByText(en.form.edit));
    fireEvent.click(await screen.findByText(en.form.save));
    await waitFor(() => expect(api.savePolicy).toHaveBeenCalledTimes(1));
    const [payload, id] = api.savePolicy.mock.calls[0];
    expect(id).toBe('p1');
    expect(payload.user_id).toBe('o1');
    expect(payload.amount_low_cents).toBe(20000);
    expect(toast).toHaveBeenCalledWith(en.page.saved, 'success');
  });

  it('surfaces a duplicate-service error from the API', async () => {
    api.savePolicy.mockRejectedValue(new Error('duplicate_service'));
    setup();
    fireEvent.click(await screen.findByText(en.form.edit));
    fireEvent.click(await screen.findByText(en.form.save));
    expect((await screen.findByRole('alert')).textContent).toBe(en.page.duplicate);
  });

  it('requires inline confirmation before deleting', async () => {
    setup();
    fireEvent.click(await screen.findByText(en.form.delete));
    expect(api.deletePolicy).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByText(en.form.delete)[0]);
    await waitFor(() => expect(api.deletePolicy).toHaveBeenCalledWith('p1'));
  });
});
