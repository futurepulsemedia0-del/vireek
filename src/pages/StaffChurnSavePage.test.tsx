import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const rpc = vi.fn();
const toast = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));

import { StaffChurnSavePage } from './StaffChurnSavePage';

const OVERVIEW = {
  days: 90,
  settings: { enabled: true, global_cooldown_days: 90 },
  offers: [
    { id: 'a', kind: 'discount', name: 'Spring 20%', enabled: true, priority: 100, target_reasons: [], target_bands: ['at_risk'], discount_percent: 20, discount_months: 3,
      max_per_account: 1, cooldown_days: 180, cap_total: 50, cap_window_days: 30, presented: 10, declined: 4, accepted: 5, failed: 0, in_cap_window: 5, retention_cohort_30d: 4, retained_30d: 3 },
  ],
  reasons: [{ reason: 'too_expensive', presented: 10, accepted: 5, declined: 4 }],
  bands: [{ band: 'at_risk', presented: 10, accepted: 5 }],
  recent: [], audit: [{ id: '1', action: 'offer_created', actor_email: 's@v.io', created_at: '2026-01-01T00:00:00Z' }],
};

const saveButton = () => {
  const all = screen.getAllByRole('button', { name: /^save$/i });
  return all[all.length - 1]; // the offer form's Save is rendered after the global-controls Save
};

beforeEach(() => { rpc.mockReset(); toast.mockReset(); });

describe('StaffChurnSavePage', () => {
  it('shows loading, then offers with caps and usage', async () => {
    rpc.mockResolvedValue({ data: OVERVIEW, error: null });
    render(<StaffChurnSavePage />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(await screen.findByText('Spring 20%')).toBeInTheDocument();
    expect(screen.getByText(/5 of 50 used in the last 30 days/)).toBeInTheDocument();
  });

  it('shows an error state with retry', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'forbidden' } });
    render(<StaffChurnSavePage />);
    expect(await screen.findByText(/Couldn't load churn-save data/i)).toBeInTheDocument();
    rpc.mockResolvedValue({ data: OVERVIEW, error: null });
    fireEvent.click(screen.getByRole('button', { name: /try again|retry/i }));
    expect(await screen.findByText('Spring 20%')).toBeInTheDocument();
  });

  it('shows the empty state', async () => {
    rpc.mockResolvedValue({ data: { ...OVERVIEW, offers: [] }, error: null });
    render(<StaffChurnSavePage />);
    expect(await screen.findByText(/No offers yet/i)).toBeInTheDocument();
  });

  it('blocks an over-ceiling discount client-side (no RPC call) and saves a valid one', async () => {
    rpc.mockResolvedValue({ data: OVERVIEW, error: null });
    render(<StaffChurnSavePage />);
    await screen.findByText('Spring 20%');
    fireEvent.click(screen.getByRole('button', { name: /add discount offer/i }));
    fireEvent.change(screen.getByLabelText(/Name \(staff only\)/i), { target: { value: 'Big sale' } });
    fireEvent.change(screen.getByLabelText(/Discount percent/i), { target: { value: '80' } });
    fireEvent.click(saveButton());
    expect(await screen.findByText(/at most 50/i)).toBeInTheDocument();
    expect(rpc.mock.calls.some((c) => c[0] === 'staff_churn_save_upsert_offer')).toBe(false);

    fireEvent.change(screen.getByLabelText(/Discount percent/i), { target: { value: '25' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(rpc.mock.calls.some((c) => c[0] === 'staff_churn_save_upsert_offer')).toBe(true));
    const call = rpc.mock.calls.find((c) => c[0] === 'staff_churn_save_upsert_offer');
    expect(call?.[1].p_offer).toMatchObject({ kind: 'discount', name: 'Big sale', discount_percent: 25, enabled: false });
  });

  it('kill switch calls the audited settings RPC', async () => {
    rpc.mockResolvedValue({ data: OVERVIEW, error: null });
    render(<StaffChurnSavePage />);
    await screen.findByText('Spring 20%');
    fireEvent.click(screen.getByLabelText(/Save offers are live/i));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('staff_churn_save_set_settings', { p_enabled: false, p_global_cooldown_days: 90 }));
  });

  it('outcomes tab shows accept rate and 30-day retention', async () => {
    rpc.mockResolvedValue({ data: OVERVIEW, error: null });
    render(<StaffChurnSavePage />);
    await screen.findByText('Spring 20%');
    fireEvent.click(screen.getByRole('tab', { name: /Outcomes/i }));
    expect(await screen.findByText('50%')).toBeInTheDocument();
    expect(screen.getByText(/3\/4 \(75%\)/)).toBeInTheDocument();
  });
});
