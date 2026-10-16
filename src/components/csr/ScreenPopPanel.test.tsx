import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ScreenPopPanel } from './ScreenPopPanel';
import { EMPTY_BALANCE, type DeskCall, type ScreenPopData } from '@/lib/csrScreenPop';

const NOW = Date.parse('2026-10-09T15:00:00Z');

const call: DeskCall = {
  id: 'c1',
  caller_phone: '+15550102030',
  caller_name: null,
  call_datetime: new Date(NOW - 60_000).toISOString(),
  duration_seconds: null,
  is_emergency: false,
  is_voicemail: false,
  human_transfer_requested: false,
  status: 'new_lead',
  sentiment: null,
  summary: null,
  intent: null,
  ended: false,
  endedAt: null,
};

const base: ScreenPopData = {
  matched: true,
  customer: {
    id: 'cu1', name: 'Maria Lopez', phone: '5550102030', email: null, address: '12 Oak St',
    customer_type: 'residential', lifecycle_stage: 'vip', tags: [], notes: null,
  },
  open_jobs: [{ id: 'j1', service_type: 'AC repair', job_status: 'scheduled', scheduled_datetime: '2026-10-12T14:00:00Z', address: null, eta_minutes: null, warranty_expires_at: null, completed_at: null }],
  recent_jobs: [],
  equipment: [{ id: 'e1', equipment_type: 'furnace', make: 'Carrier', model: 'X1', install_date: '2020-01-01', warranty_expires_at: null, expected_lifespan_years: 15, service_interval_months: 12, last_service_date: null }],
  balance: { outstanding_cents: 45000, overdue_cents: 15000, open_invoice_count: 2, oldest_due_date: '2026-09-01' },
  open_quotes: [],
  last_conversation: {
    call_id: 'c0', call_datetime: '2026-09-20T10:00:00Z', summary: 'Asked about a tune-up', sentiment: 'positive', intent: null,
    recommended_follow_up: 'Offer maintenance plan', objections_raised: [], objections_resolved: null, duration_seconds: 120,
  },
  memory: [{ category: 'access_info', fact: 'Gate code is on the fence' }],
  history: { total_calls: 2, last_call_at: '2026-09-20T10:00:00Z' },
};

const renderPanel = (data: ScreenPopData, canViewBilling = true) =>
  render(
    <MemoryRouter>
      <ScreenPopPanel call={call} data={data} canViewBilling={canViewBilling} now={NOW} />
    </MemoryRouter>
  );

describe('ScreenPopPanel', () => {
  it('shows customer, open jobs, equipment, balance, last conversation and script', () => {
    renderPanel(base);
    expect(screen.getByText('Maria Lopez')).toBeInTheDocument();
    expect(screen.getByText('(555) 010-2030')).toBeInTheDocument();
    expect(screen.getByText('AC repair')).toBeInTheDocument();
    expect(screen.getByText(/Carrier X1/)).toBeInTheDocument();
    expect(screen.getByText('$450.00')).toBeInTheDocument();
    expect(screen.getByText(/\$150\.00 overdue/, { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Asked about a tune-up')).toBeInTheDocument();
    expect(screen.getByText(/Gate code is on the fence/)).toBeInTheDocument();
    expect(screen.getByTestId('suggested-script')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open customer record/i })).toHaveAttribute('href', '/dashboard/customers/cu1');
  });

  it('hides the balance amount when the role cannot view billing', () => {
    renderPanel(base, false);
    expect(screen.queryByText('$450.00')).not.toBeInTheDocument();
    expect(screen.getByText(/restricted for your role/i)).toBeInTheDocument();
  });

  it('renders honest empty states for a brand-new caller', () => {
    renderPanel({
      ...base, matched: false, customer: null, open_jobs: [], equipment: [], last_conversation: null, memory: [],
      balance: { ...EMPTY_BALANCE }, history: { total_calls: 0, last_call_at: null },
    });
    expect(screen.getByText('Unknown caller')).toBeInTheDocument();
    expect(screen.getByText('No open jobs.')).toBeInTheDocument();
    expect(screen.getByText('No equipment on file.')).toBeInTheDocument();
    expect(screen.getByText('No outstanding invoices.')).toBeInTheDocument();
    expect(screen.getByText(/First time we have heard from this number/)).toBeInTheDocument();
    expect(screen.getAllByText(/New caller/).length).toBeGreaterThan(0);
  });
});
