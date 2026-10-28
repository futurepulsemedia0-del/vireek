import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const auth = {
  profile: { id: 'owner-1', role: 'owner', plan: 'enterprise' } as { id: string; role: string; plan: string },
  isOwner: true,
};
const toast = vi.fn();
const api = {
  fetchDestinations: vi.fn(),
  fetchDeliveryLog: vi.fn(),
  saveDestination: vi.fn(),
  testDestination: vi.fn(),
  setDestinationEnabled: vi.fn(),
  deleteDestination: vi.fn(),
  deliverNow: vi.fn(),
};

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/components/ConfirmDialog', () => ({
  ConfirmDialog: ({ open, title, confirmLabel, onConfirm, onCancel }: { open: boolean; title: string; confirmLabel?: string; onConfirm: () => void; onCancel: () => void }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        <button onClick={() => void onConfirm()}>{confirmLabel}</button>
        <button onClick={onCancel}>Cancel dialog</button>
      </div>
    ) : null,
}));
vi.mock('@/lib/siemStreaming', async () => {
  const actual = await vi.importActual<typeof import('@/lib/siemStreaming')>('@/lib/siemStreaming');
  return {
    ...actual,
    fetchDestinations: (...a: unknown[]) => api.fetchDestinations(...a),
    fetchDeliveryLog: (...a: unknown[]) => api.fetchDeliveryLog(...a),
    saveDestination: (...a: unknown[]) => api.saveDestination(...a),
    testDestination: (...a: unknown[]) => api.testDestination(...a),
    setDestinationEnabled: (...a: unknown[]) => api.setDestinationEnabled(...a),
    deleteDestination: (...a: unknown[]) => api.deleteDestination(...a),
    deliverNow: (...a: unknown[]) => api.deliverNow(...a),
  };
});

import { SiemStreamingPage } from './SiemStreamingPage';

const dest = (over: Record<string, unknown> = {}) => ({
  id: 'd1',
  name: 'Prod Splunk',
  provider: 'splunk_hec',
  endpoint_url: 'https://splunk.acme.com:8088/services/collector/event',
  datadog_site: null,
  splunk_index: null,
  splunk_sourcetype: null,
  min_severity: 'info',
  enabled: true,
  status: 'active',
  next_attempt_at: null,
  consecutive_failures: 0,
  last_success_at: new Date(Date.now() - 120_000).toISOString(),
  last_error: null,
  last_error_at: null,
  events_sent_total: 1250,
  events_dropped_total: 0,
  created_at: '2027-12-30T00:00:00Z',
  updated_at: '2027-12-30T00:00:00Z',
  ...over,
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <SiemStreamingPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  toast.mockReset();
  auth.isOwner = true;
  auth.profile = { id: 'owner-1', role: 'owner', plan: 'enterprise' };
  api.fetchDestinations.mockResolvedValue([]);
  api.fetchDeliveryLog.mockResolvedValue([]);
});

describe('SiemStreamingPage — access', () => {
  it('shows owner-only message to non-owners and does not load data', () => {
    auth.isOwner = false;
    renderPage();
    expect(screen.getByText('Owner access only')).toBeInTheDocument();
    expect(api.fetchDestinations).not.toHaveBeenCalled();
  });

  it('shows an upgrade prompt on ineligible plans', () => {
    auth.profile = { id: 'owner-1', role: 'owner', plan: 'professional' };
    renderPage();
    expect(screen.getByText('Available on Business and Enterprise')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /compare plans/i })).toHaveAttribute('href', '/dashboard/billing/plans');
    expect(api.fetchDestinations).not.toHaveBeenCalled();
  });
});

describe('SiemStreamingPage — list states', () => {
  it('shows the empty state and opens the form', async () => {
    renderPage();
    expect(await screen.findByText('No destinations yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /add your first destination/i }));
    expect(screen.getByRole('form', { name: /add destination/i })).toBeInTheDocument();
  });

  it('shows an error with a working retry', async () => {
    api.fetchDestinations.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce([dest()]);
    renderPage();
    expect(await screen.findByText(/couldn’t load your destinations/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Prod Splunk')).toBeInTheDocument();
  });

  it('renders healthy and failing destinations with their status and last error', async () => {
    api.fetchDestinations.mockResolvedValue([
      dest(),
      dest({ id: 'd2', name: 'Datadog EU', provider: 'datadog', endpoint_url: null, datadog_site: 'datadoghq.eu', status: 'auth_failed', last_error: 'HTTP 403: Invalid token', last_error_at: new Date().toISOString() }),
    ]);
    renderPage();
    expect(await screen.findByText('Streaming')).toBeInTheDocument();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText('HTTP 403: Invalid token')).toBeInTheDocument();
    expect(screen.getByText('1,250')).toBeInTheDocument();
  });

  it('labels a paused destination and offers resume', async () => {
    api.fetchDestinations.mockResolvedValue([dest({ enabled: false })]);
    renderPage();
    expect(await screen.findByText('Paused')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resume streaming to prod splunk/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send now to prod splunk/i })).toBeDisabled();
  });
});

describe('SiemStreamingPage — form', () => {
  it('blocks submit and shows field errors for an empty form', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /add your first destination/i }));
    fireEvent.click(screen.getByRole('button', { name: /^add destination$/i }));
    expect(await screen.findByText('Give this destination a name.')).toBeInTheDocument();
    expect(screen.getByText('Enter your Splunk HEC URL.')).toBeInTheDocument();
    expect(screen.getByText('Enter your HEC token.')).toBeInTheDocument();
    expect(api.saveDestination).not.toHaveBeenCalled();
  });

  it('rejects an insecure URL client-side', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /add your first destination/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'SIEM' } });
    fireEvent.change(screen.getByLabelText('HEC URL'), { target: { value: 'http://splunk.acme.com' } });
    fireEvent.change(screen.getByLabelText('HEC token'), { target: { value: 'abcd-1234-efgh' } });
    fireEvent.click(screen.getByRole('button', { name: /^add destination$/i }));
    expect(await screen.findByText('The HEC URL must use https://.')).toBeInTheDocument();
    expect(api.saveDestination).not.toHaveBeenCalled();
  });

  it('saves a valid destination, toasts and reloads the list', async () => {
    api.saveDestination.mockResolvedValue('new-1');
    api.fetchDestinations.mockResolvedValueOnce([]).mockResolvedValueOnce([dest({ id: 'new-1', name: 'SIEM' })]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /add your first destination/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'SIEM' } });
    fireEvent.change(screen.getByLabelText('HEC URL'), { target: { value: 'https://splunk.acme.com:8088' } });
    fireEvent.change(screen.getByLabelText('HEC token'), { target: { value: 'abcd-1234-efgh' } });
    fireEvent.click(screen.getByRole('button', { name: /^add destination$/i }));
    await waitFor(() => expect(api.saveDestination).toHaveBeenCalledTimes(1));
    expect(api.saveDestination.mock.calls[0][0]).toMatchObject({ provider: 'splunk_hec', name: 'SIEM', secret: 'abcd-1234-efgh' });
    expect(await screen.findByRole('list', { name: /siem destinations/i })).toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/destination added/i), 'success');
  });

  it('shows the server error and keeps the form open', async () => {
    api.saveDestination.mockRejectedValue(new Error('You can configure up to 5 destinations.'));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /add your first destination/i }));
    fireEvent.click(screen.getByLabelText(/datadog logs/i));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'DD' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'dd-key-12345678' } });
    fireEvent.click(screen.getByRole('button', { name: /^add destination$/i }));
    expect(await screen.findByText('You can configure up to 5 destinations.')).toBeInTheDocument();
    expect(screen.getByRole('form', { name: /add destination/i })).toBeInTheDocument();
  });

  it('edits without requiring the token again and locks the provider', async () => {
    api.fetchDestinations.mockResolvedValue([dest()]);
    api.saveDestination.mockResolvedValue('d1');
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /edit prod splunk/i }));
    expect(screen.getByLabelText(/splunk \(http event collector\)/i)).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Prod Splunk 2' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(api.saveDestination).toHaveBeenCalled());
    expect(api.saveDestination.mock.calls[0][1]).toBe('d1');
  });
});

describe('SiemStreamingPage — actions', () => {
  beforeEach(() => {
    api.fetchDestinations.mockResolvedValue([dest()]);
  });

  it('sends a test event and shows success', async () => {
    api.testDestination.mockResolvedValue({ ok: true, duration_ms: 84 });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /send test event to prod splunk/i }));
    expect(await screen.findByText(/test event delivered in 84 ms/i)).toBeInTheDocument();
  });

  it('shows a failed test result', async () => {
    api.testDestination.mockResolvedValue({ ok: false, error: 'HTTP 403: Invalid token' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /send test event to prod splunk/i }));
    expect(await screen.findByText(/test failed: http 403/i)).toBeInTheDocument();
  });

  it('toasts an error when an action throws', async () => {
    api.testDestination.mockRejectedValue(new Error('Network down'));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /send test event to prod splunk/i }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Network down', 'error'));
  });

  it('pauses streaming', async () => {
    api.setDestinationEnabled.mockResolvedValue(undefined);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /pause streaming to prod splunk/i }));
    await waitFor(() => expect(api.setDestinationEnabled).toHaveBeenCalledWith('d1', false));
  });

  it('sends pending events now', async () => {
    api.deliverNow.mockResolvedValue({ ok: true, sent: 42 });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /send now to prod splunk/i }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Sent 42 events.', 'success'));
  });

  it('deletes only after confirmation', async () => {
    api.deleteDestination.mockResolvedValue(undefined);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /delete prod splunk/i }));
    expect(api.deleteDestination).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete destination' }));
    await waitFor(() => expect(api.deleteDestination).toHaveBeenCalledWith('d1'));
  });

  it('does not delete when the dialog is cancelled', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /delete prod splunk/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel dialog' }));
    expect(api.deleteDestination).not.toHaveBeenCalled();
  });
});

describe('SiemStreamingPage — delivery log', () => {
  beforeEach(() => {
    api.fetchDestinations.mockResolvedValue([dest()]);
  });

  it('shows an empty log', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /show delivery log/i }));
    expect(await screen.findByText(/no deliveries yet/i)).toBeInTheDocument();
  });

  it('lists deliveries', async () => {
    api.fetchDeliveryLog.mockResolvedValue([
      { id: 'l1', kind: 'delivery', status: 'ok', event_count: 120, dropped_count: 0, http_status: 200, error: null, duration_ms: 90, created_at: new Date().toISOString() },
      { id: 'l2', kind: 'delivery', status: 'failed', event_count: 0, dropped_count: 0, http_status: 503, error: 'HTTP 503: Server busy', created_at: new Date().toISOString(), duration_ms: 10 },
    ]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /show delivery log/i }));
    expect(await screen.findByText('Delivered')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('HTTP 503: Server busy')).toBeInTheDocument();
  });

  it('shows an error with retry', async () => {
    api.fetchDeliveryLog.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce([]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /show delivery log/i }));
    expect(await screen.findByText(/couldn’t load the delivery log/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText(/no deliveries yet/i)).toBeInTheDocument();
  });
});
