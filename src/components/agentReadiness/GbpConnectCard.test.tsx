import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GbpConnectCard } from '@/components/agentReadiness/GbpConnectCard';
import type { GbpConnection } from '@/lib/gbpConnectCore';

const api = vi.hoisted(() => ({ load: vi.fn(), start: vi.fn(), select: vi.fn() }));
vi.mock('@/lib/gbpConnect', async () => ({
  ...(await vi.importActual<typeof import('@/lib/gbpConnectCore')>('@/lib/gbpConnectCore')),
  loadGbpConnection: api.load, startGbpConnect: api.start, selectGbpLocation: api.select,
}));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const conn = (c: Partial<GbpConnection>): GbpConnection => ({ state: 'not_connected', locationName: null, locationTitle: null, candidates: [], ...c });

describe('GbpConnectCard', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders nothing for members who cannot manage', () => {
    const { container } = render(<GbpConnectCard canManage={false} returned={null} />);
    expect(container.textContent).toBe('');
    expect(api.load).not.toHaveBeenCalled();
  });
  it('offers Connect when not connected and starts the flow', async () => {
    api.load.mockResolvedValue(conn({}));
    api.start.mockResolvedValue({ ok: false, code: 'not_configured' });
    render(<GbpConnectCard canManage returned={null} />);
    fireEvent.click(await screen.findByRole('button', { name: /connect google business profile/i }));
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
  });
  it('asks the user to choose when several locations came back and saves the choice', async () => {
    api.load.mockResolvedValue(conn({ state: 'needs_choice', candidates: [{ location: 'locations/1', title: 'North shop' }, { location: 'locations/2', title: 'South shop' }] }));
    api.select.mockResolvedValue({ ok: true });
    render(<GbpConnectCard canManage returned={{ status: 'choose', reason: null }} />);
    fireEvent.click(await screen.findByRole('radio', { name: 'South shop' }));
    fireEvent.click(screen.getByRole('button', { name: /use this location/i }));
    await waitFor(() => expect(api.select).toHaveBeenCalledWith('locations/2'));
  });
  it('shows the connected location and an alert for a failed return', async () => {
    api.load.mockResolvedValue(conn({ state: 'connected', locationName: 'locations/1', locationTitle: 'Acme Plumbing', candidates: [{ location: 'locations/1', title: 'Acme Plumbing' }] }));
    render(<GbpConnectCard canManage returned={{ status: 'error', reason: 'access_denied' }} />);
    expect(await screen.findByText(/connected to acme plumbing/i)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/not granted/i);
  });
  it('shows a retryable error when the status cannot be loaded', async () => {
    api.load.mockRejectedValue(new Error('x'));
    render(<GbpConnectCard canManage returned={null} />);
    fireEvent.click(await screen.findByRole('button', { name: /retry/i }));
    await waitFor(() => expect(api.load).toHaveBeenCalledTimes(2));
  });
});
