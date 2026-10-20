import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({ supabase: { rpc } }));

import { OnMyWayView } from './OnMyWayView';
import type { JobTracking } from '@/lib/liveTracking';

const NOW = Date.parse('2027-03-01T15:00:00Z');

const base: JobTracking = {
  business_name: 'Acme HVAC',
  customer_name: 'Sam',
  service_type: 'AC repair',
  job_status: 'scheduled',
  scheduled_datetime: '2027-03-01T15:00:00Z',
  technician_name: 'Alex Rivera',
  technician_photo_url: null,
  eta_minutes: null,
  eta_set_at: null,
  technician_lat: null,
  technician_lng: null,
  location_updated_at: null,
  position_source: null,
  site_lat: null,
  site_lng: null,
  arrival_window_start: '2027-03-01T15:00:00Z',
  arrival_window_end: '2027-03-01T16:00:00Z',
  arrived_at: null,
  can_reschedule: false,
  review_token: null,
  review_status: null,
  server_time: '2027-03-01T15:00:00Z',
};

function renderView(over: Partial<JobTracking> = {}) {
  return render(
    <MemoryRouter>
      <OnMyWayView tracking={{ ...base, ...over }} token="tok-1" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  rpc.mockReset();
  rpc.mockResolvedValue({ data: 'rev-token', error: null });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('OnMyWayView', () => {
  it('shows a live ETA, the technician photo and the map while en route', () => {
    renderView({
      job_status: 'en_route',
      technician_photo_url: 'https://cdn.example.com/alex.jpg',
      technician_lat: 30.0,
      technician_lng: -97.0,
      site_lat: 30.05,
      site_lng: -97.0,
      location_updated_at: new Date(NOW - 30_000).toISOString(),
      position_source: 'telematics',
    });
    expect(screen.getByText(/^\d+ min$/)).toBeInTheDocument();
    expect(screen.getByText(/Live GPS/)).toBeInTheDocument();
    expect(screen.getByText('Alex Rivera')).toBeInTheDocument();
    expect(screen.getByAltText('Photo of Alex Rivera')).toHaveAttribute('src', 'https://cdn.example.com/alex.jpg');
    expect(screen.getByTitle('Technician location')).toBeInTheDocument();
  });

  it('shows the arrival window, initials fallback and a reschedule link when scheduled', () => {
    renderView({ can_reschedule: true });
    expect(screen.getByText('Arrival window')).toBeInTheDocument();
    expect(screen.getByText('AR')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /reschedule/i })).toHaveAttribute('href', '/reschedule/tok-1');
  });

  it('hides the reschedule link when rescheduling is not allowed', () => {
    renderView({ can_reschedule: false });
    expect(screen.queryByRole('link', { name: /reschedule/i })).not.toBeInTheDocument();
  });

  it('prompts for a review after completion and deep-links the chosen rating', async () => {
    renderView({ job_status: 'completed' });
    const star = await screen.findByRole('link', { name: 'Rate 4 out of 5' });
    expect(star).toHaveAttribute('href', '/review/rev-token?rating=4');
    expect(rpc).toHaveBeenCalledWith('ensure_job_review_request', { p_token: 'tok-1' });
  });

  it('thanks the customer instead of asking again once reviewed', async () => {
    renderView({ job_status: 'completed', review_status: 'completed', review_token: 'rev-token' });
    expect(screen.getByText(/we have your feedback/i)).toBeInTheDocument();
    await waitFor(() => expect(rpc).not.toHaveBeenCalled());
  });

  it('shows no reschedule or review prompt for a cancelled visit', () => {
    renderView({ job_status: 'cancelled', can_reschedule: false });
    expect(screen.getByText('This visit was cancelled.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /rate/i })).not.toBeInTheDocument();
  });
});
