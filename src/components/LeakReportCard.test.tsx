import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { computeLeakReport } from '../../supabase/functions/_shared/leak-report/core';
import type { LeakData } from '@/lib/leakReportApi';

const hook = vi.hoisted(() => ({ useLeakReport: vi.fn() }));
vi.mock('@/hooks/useLeakReport', () => hook);

import { LeakReportCard } from './LeakReportCard';

const settings = { enabled: true, started_at: '2026-10-20T00:00:00Z', window_days: 7, timezone: 'America/New_York', avg_ticket_cents: 45000, close_rate_bps: 3000 };
const report = computeLeakReport({
  events: [
    { id: '1', startedAt: '2026-10-21T15:00:00Z', direction: 'inbound', answered: false, isVoicemail: false, ringSeconds: null, durationSeconds: null, phoneKey: '4155550002' },
    { id: '2', startedAt: '2026-10-21T16:00:00Z', direction: 'inbound', answered: true, isVoicemail: false, ringSeconds: 6, durationSeconds: 60, phoneKey: '4155550003' },
  ],
  windowStart: new Date('2026-10-20T00:00:00Z'),
  windowEnd: new Date('2026-10-27T00:00:00Z'),
  timeZone: 'America/New_York',
  businessHours: null,
  avgTicketCents: 45000,
  nowMs: Date.parse('2026-10-24T12:00:00Z'),
});
const data = (phase: LeakData['phase']): LeakData => ({ settings: { ...settings, enabled: phase !== 'off' }, phase, report, windowStart: settings.started_at, windowEnd: '2026-10-27T00:00:00Z', dayNumber: 4, ticketSource: 'override', ticketJobCount: 0 });
const mockState = (state: unknown) => hook.useLeakReport.mockReturnValue({ state, reload: vi.fn(), accountOwnerId: 'o1', canAccess: true });
const renderCard = () => render(<MemoryRouter><LeakReportCard /></MemoryRouter>);

beforeEach(() => vi.clearAllMocks());

describe('LeakReportCard', () => {
  it('renders nothing without permission', () => {
    mockState({ status: 'forbidden' });
    const { container } = renderCard();
    expect(container).toBeEmptyDOMElement();
  });
  it('shows a loading state', () => {
    mockState({ status: 'loading' });
    renderCard();
    expect(screen.getByRole('status', { name: /loading leak report/i })).toBeInTheDocument();
  });
  it('shows an error with retry', () => {
    mockState({ status: 'error', message: 'Boom' });
    renderCard();
    expect(screen.getByRole('alert')).toHaveTextContent('Boom');
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
  it('invites the owner to start when the mode is off', () => {
    mockState({ status: 'ready', data: data('off') });
    renderCard();
    expect(screen.getByRole('link', { name: /start the report/i })).toHaveAttribute('href', '/dashboard/leak-report');
  });
  it('asks to connect calls while waiting', () => {
    mockState({ status: 'ready', data: data('waiting') });
    renderCard();
    expect(screen.getByRole('link', { name: /connect calls/i })).toBeInTheDocument();
  });
  it('shows the estimated loss, progress and a link to the full report while collecting', () => {
    mockState({ status: 'ready', data: data('collecting') });
    renderCard();
    expect(screen.getByText(/\$135 estimated lost/)).toBeInTheDocument();
    expect(screen.getByText(/Day 4 of 7/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view full report/i })).toHaveAttribute('href', '/dashboard/leak-report');
  });
  it('labels a finished report as final without a progress bar', () => {
    mockState({ status: 'ready', data: data('complete') });
    renderCard();
    expect(screen.getByText(/Final/)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});
