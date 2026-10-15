import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SystemHealthStrip } from './SystemHealthStrip';
import type { UseSystemHealth } from '@/hooks/useSystemHealth';
import { evaluateSystemHealth, summarizeHealth, type SystemHealthSnapshot } from '@/lib/systemHealth';

const mockHook = vi.fn<() => UseSystemHealth>();
vi.mock('@/hooks/useSystemHealth', () => ({ useSystemHealth: () => mockHook() }));

afterEach(() => {
  cleanup();
  mockHook.mockReset();
});

const NOW = new Date('2026-10-14T12:00:00Z');
const snapshot: SystemHealthSnapshot = {
  generated_at: NOW.toISOString(),
  voice: { assistant_linked: false, calls_7d: 0, last_call_at: null },
  phone: { total: 1, active: 1, active_voice: 1, pending: 0, porting: 0 },
  sms: { active_sms_numbers: 0, brand_status: 'not_started', campaign_status: 'not_started', rejection_reason: null },
  stripe: {
    has_customer: true,
    subscription_status: 'active',
    grace_ends_at: null,
    last_payment_error: null,
    connect: { exists: false, charges_enabled: false, payouts_enabled: false, details_submitted: false },
  },
  integrations: {},
  webhooks: { endpoints_active: 0, endpoints_failing: 0, deliveries_24h: 0, errors_24h: 0, last_error_at: null, last_error_message: null },
};

function ready(): UseSystemHealth {
  const checks = evaluateSystemHealth(snapshot, NOW);
  return { status: 'ready', checks, summary: summarizeHealth(checks), checkedAt: NOW, refreshing: false, refresh: vi.fn() };
}

const renderStrip = () =>
  render(
    <MemoryRouter>
      <SystemHealthStrip />
    </MemoryRouter>,
  );

describe('SystemHealthStrip', () => {
  it('renders all seven subsystems with state and a fix link only on problems', () => {
    mockHook.mockReturnValue(ready());
    renderStrip();
    for (const label of ['Voice AI', 'Phone numbers', 'SMS / A2P', 'Stripe', 'Google Calendar', 'QuickBooks', 'Webhooks']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByTestId('health-voice')).toHaveAttribute('data-state', 'red');
    expect(screen.getByTestId('health-phone')).toHaveAttribute('data-state', 'green');
    expect(screen.getByRole('link', { name: /link assistant/i })).toHaveAttribute('href', '/dashboard/settings/assistant');
    expect(screen.getByTestId('health-phone').querySelector('a')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('1 issue needs attention');
  });

  it('shows a busy skeleton while loading', () => {
    mockHook.mockReturnValue({ status: 'loading', checks: [], summary: null, checkedAt: null, refreshing: true, refresh: vi.fn() });
    renderStrip();
    expect(screen.getByRole('region', { name: /system health/i })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Checking');
  });

  it('never fakes green on failure: shows unknown state with a working retry', () => {
    const refresh = vi.fn();
    mockHook.mockReturnValue({ status: 'error', checks: [], summary: null, checkedAt: null, refreshing: false, refresh });
    renderStrip();
    expect(screen.getByText(/status is unknown/i)).toBeInTheDocument();
    expect(screen.queryByText('Healthy')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('refresh button calls refresh and is disabled while refreshing', () => {
    const state = ready();
    mockHook.mockReturnValue(state);
    renderStrip();
    fireEvent.click(screen.getByRole('button', { name: /refresh system health/i }));
    expect(state.refresh).toHaveBeenCalledOnce();
    cleanup();
    mockHook.mockReturnValue({ ...state, refreshing: true });
    renderStrip();
    expect(screen.getByRole('button', { name: /refresh system health/i })).toBeDisabled();
  });
});
