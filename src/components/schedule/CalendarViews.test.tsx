import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Job, TeamMember } from '@/lib/supabase';
import { CalendarExtendedViews, CalendarViewSwitcher } from './CalendarViews';

// Drag-and-drop is covered by ScheduleDnd's own tests; here the wrappers are transparent.
vi.mock('@/components/schedule/ScheduleDnd', () => ({
  DraggableJob: ({ children }: { children: ReactNode }) => <div data-testid="draggable">{children}</div>,
  DropZone: ({ children, label }: { children: ReactNode; label: string }) => (
    <div data-testid="dropzone" data-label={label}>
      {children}
    </div>
  ),
}));

const at = (d: number, h: number) => new Date(2026, 9, d, h, 0, 0, 0).toISOString();

function job(o: Partial<Job>): Job {
  return {
    id: 'j',
    customer_name: 'Customer',
    service_type: 'Plumbing',
    scheduled_datetime: at(14, 9),
    duration_minutes: 60,
    assigned_technician_id: null,
    job_status: 'scheduled',
    tags: [],
    ...o,
  } as Job;
}

const MARIA = { id: 't1', member_name: 'Maria Lopez', member_email: 'm@x.com', max_jobs_per_day: 1 } as TeamMember;
const LANES = [
  { key: 'unassigned', technician: null as TeamMember | null },
  { key: 't1', technician: MARIA },
];

function renderView(over: Partial<Parameters<typeof CalendarExtendedViews>[0]> = {}) {
  const props = {
    view: 'month' as const,
    anchorDate: new Date(2026, 9, 14),
    onAnchorChange: vi.fn(),
    onOpenDay: vi.fn(),
    jobs: [] as Job[],
    technicians: [MARIA],
    lanes: LANES,
    colorMode: 'status' as const,
    agendaGroupBy: 'date' as const,
    isDraggable: () => true,
    pendingIds: new Set<string>(),
    moveTargetsFor: () => [],
    onCardClick: vi.fn(),
    ...over,
  };
  render(<CalendarExtendedViews {...props} />);
  return props;
}

describe('Month view', () => {
  it('renders a labelled grid with weekday headers and every day of the month', () => {
    renderView();
    expect(screen.getByRole('grid', { name: /October 2026 calendar/i })).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader')).toHaveLength(7);
    expect(screen.getByRole('gridcell', { name: /Wednesday, October 14, 2026, no jobs/i })).toBeInTheDocument();
    expect(screen.getByText(/No jobs scheduled in October 2026/i)).toBeInTheDocument();
  });

  it('shows jobs, caps a cell at three chips and reveals the rest via "+N more"', () => {
    const jobs = [1, 2, 3, 4, 5].map((n) => job({ id: `j${n}`, customer_name: `Cust ${n}`, scheduled_datetime: at(14, 7 + n) }));
    const props = renderView({ jobs });
    const cell = screen.getByRole('gridcell', { name: /October 14, 2026, 5 jobs/i });
    expect(within(cell).getByText('+2 more')).toBeInTheDocument();
    fireEvent.click(within(cell).getByText('+2 more'));
    expect(props.onOpenDay).toHaveBeenCalledTimes(1);
  });

  it('opens a job when its chip is clicked', () => {
    const j = job({ id: 'a', customer_name: 'Acme Corp' });
    const props = renderView({ jobs: [j] });
    fireEvent.click(screen.getByRole('button', { name: /Acme Corp.*Open to reschedule/i }));
    expect(props.onCardClick).toHaveBeenCalledWith(j);
  });

  it('uses a roving tabindex: only the focused day is a tab stop', () => {
    renderView();
    const cells = screen.getAllByRole('gridcell');
    expect(cells.filter((c) => c.tabIndex === 0)).toHaveLength(1);
    expect(screen.getByRole('gridcell', { name: /October 14, 2026/ }).tabIndex).toBe(0);
  });

  it('moves the focused day with the arrow keys, Home/End and Page keys', () => {
    const props = renderView();
    const cell = screen.getByRole('gridcell', { name: /October 14, 2026/ });
    const day = (n: number) => props.onAnchorChange.mock.calls[n][0] as Date;
    fireEvent.keyDown(cell, { key: 'ArrowRight' });
    fireEvent.keyDown(cell, { key: 'ArrowDown' });
    fireEvent.keyDown(cell, { key: 'Home' });
    fireEvent.keyDown(cell, { key: 'PageDown' });
    expect(day(0).getDate()).toBe(15);
    expect(day(1).getDate()).toBe(21);
    expect(day(2).getDate()).toBe(12);
    expect(day(3).getMonth()).toBe(10);
  });

  it('opens the day on Enter and ignores keys with modifiers or from inner controls', () => {
    const props = renderView({ jobs: [job({ customer_name: 'Acme' })] });
    const cell = screen.getByRole('gridcell', { name: /October 14, 2026/ });
    fireEvent.keyDown(cell, { key: 'Enter' });
    expect(props.onOpenDay).toHaveBeenCalledTimes(1);
    expect((props.onOpenDay.mock.calls[0][0] as Date).getDate()).toBe(14);
    fireEvent.keyDown(cell, { key: 'ArrowRight', ctrlKey: true });
    fireEvent.keyDown(screen.getByRole('button', { name: /Acme/ }), { key: 'ArrowRight' });
    expect(props.onAnchorChange).not.toHaveBeenCalled();
  });

  it('marks today with aria-current', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 14, 12));
    renderView();
    expect(screen.getByRole('gridcell', { name: /October 14, 2026/ })).toHaveAttribute('aria-current', 'date');
    vi.useRealTimers();
  });
});

describe('Agenda view', () => {
  const jobs = [
    job({ id: 'a', customer_name: 'Early Bird', scheduled_datetime: at(12, 8), assigned_technician_id: 't1', job_status: 'on_hold' }),
    job({ id: 'b', customer_name: 'Late Owl', scheduled_datetime: at(12, 16) }),
    job({ id: 'c', customer_name: 'Next Day', scheduled_datetime: at(13, 9) }),
  ];

  it('groups by date with a heading and count per day', () => {
    renderView({ view: 'agenda', jobs });
    expect(screen.getByRole('heading', { name: /Monday, October 12/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Tuesday, October 13/ })).toBeInTheDocument();
    expect(screen.getByText('2 jobs')).toBeInTheDocument();
    // workflow status label appears on the job row (and once more in the legend)
    expect(screen.getAllByText('On hold').length).toBeGreaterThan(1);
  });

  it('groups by technician', () => {
    renderView({ view: 'agenda', jobs, agendaGroupBy: 'technician' });
    expect(screen.getByRole('heading', { name: 'Maria Lopez' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Unassigned' })).toBeInTheDocument();
  });

  it('shows an empty state', () => {
    renderView({ view: 'agenda', jobs: [] });
    expect(screen.getByText(/Nothing scheduled in October 2026/i)).toBeInTheDocument();
  });
});

describe('Resources view', () => {
  it('lists each technician lane and flags days over capacity', () => {
    const jobs = [
      job({ id: 'a', assigned_technician_id: 't1', scheduled_datetime: at(14, 9) }),
      job({ id: 'b', assigned_technician_id: 't1', scheduled_datetime: at(14, 13) }),
    ];
    renderView({ view: 'resources', jobs });
    expect(screen.getByRole('group', { name: /Maria Lopez, 2 jobs this week/ })).toBeInTheDocument();
    expect(screen.getByText(/Over capacity \(2\/1\)/)).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /Unassigned, 0 jobs this week/ })).toBeInTheDocument();
  });
});

describe('Legend & print', () => {
  it('shows a legend for the active colour mode with counts', () => {
    renderView({ jobs: [job({ id: 'a' }), job({ id: 'b' }), job({ id: 'c', job_status: 'completed' })] });
    const legend = screen.getByRole('list', { name: /Status legend/i });
    expect(within(legend).getByText('Scheduled')).toBeInTheDocument();
    expect(within(legend).getByText('Completed')).toBeInTheDocument();
  });

  it('colours by trade when asked', () => {
    renderView({ colorMode: 'trade', jobs: [job({ service_type: 'Furnace repair' })] });
    expect(within(screen.getByRole('list', { name: /Trade legend/i })).getByText('HVAC')).toBeInTheDocument();
  });

  it('prints a title with the view, period and filter summary', () => {
    renderView({ filterSummary: 'Maria Lopez' });
    expect(screen.getByText(/Dispatch Calendar — Month · October 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Maria Lopez · Printed/)).toBeInTheDocument();
  });
});

describe('CalendarViewSwitcher', () => {
  it('exposes the active view with aria-pressed and reports changes', () => {
    const onChange = vi.fn();
    render(<CalendarViewSwitcher view="agenda" onChange={onChange} />);
    expect(screen.getByRole('button', { name: /Agenda/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Month/ })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: /Month/ }));
    expect(onChange).toHaveBeenCalledWith('month');
  });
});
