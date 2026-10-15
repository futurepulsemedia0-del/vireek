import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { JobWorkflowBoard, type JobWorkflowBoardProps } from './JobWorkflowBoard';
import { emptyWorkflowBuckets, type JobHold } from '@/lib/jobWorkflow';
import type { Job } from '@/lib/supabase';

const NOW = new Date('2027-06-10T12:00:00.000Z');
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const H = 3_600_000;

const job = (id: string, name: string, status: Job['job_status']) => ({ id, customer_name: name, service_type: 'HVAC repair', job_status: status }) as unknown as Job;

function hold(over: Partial<JobHold>): JobHold {
  return {
    id: 'h',
    user_id: 'u',
    job_id: 'j1',
    status: 'waiting_on_parts',
    reason_code: 'part_backordered',
    reason_note: 'Supplier says Friday',
    previous_status: 'in_progress',
    expected_resume_at: null,
    started_at: iso(-30 * H),
    sla_minutes: 1440,
    sla_due_at: iso(-6 * H),
    sla_breached_at: null,
    reminders_sent: 0,
    max_reminders: 5,
    next_reminder_at: null,
    last_reminded_at: null,
    resolved_at: null,
    resolved_to_status: null,
    resolution_note: null,
    created_at: iso(-30 * H),
    ...over,
  };
}

function setup(over: Partial<JobWorkflowBoardProps> = {}) {
  const jobsByStatus = { ...emptyWorkflowBuckets(), waiting_on_parts: [job('j1', 'Ann Lee', 'waiting_on_parts')] } as unknown as JobWorkflowBoardProps['jobsByStatus'];
  const props: JobWorkflowBoardProps = {
    jobsByStatus,
    holdsByJob: new Map([['j1', hold({})]]),
    now: NOW,
    draggingId: null,
    dragOverStage: null,
    onDragOver: vi.fn(),
    onDragLeave: vi.fn(),
    onDrop: vi.fn(),
    onCardDragStart: vi.fn(),
    onCardDragEnd: vi.fn(),
    onOpenJob: vi.fn(),
    ...over,
  };
  render(<JobWorkflowBoard {...props} />);
  return props;
}

describe('JobWorkflowBoard', () => {
  it('opens by default when a job is paused and renders all five columns', () => {
    setup();
    for (const s of ['on_hold', 'waiting_on_parts', 'waiting_on_customer', 'needs_follow_up', 'return_visit_needed']) {
      expect(screen.getByTestId(`workflow-column-${s}`)).toBeInTheDocument();
    }
  });

  it('shows the job with its reason, note and an overdue SLA chip', () => {
    setup();
    const col = screen.getByTestId('workflow-column-waiting_on_parts');
    expect(within(col).getByText('Ann Lee')).toBeInTheDocument();
    expect(within(col).getByText('Part back-ordered')).toBeInTheDocument();
    expect(within(col).getByText('Supplier says Friday')).toBeInTheDocument();
    expect(within(col).getByText('Overdue by 6h')).toHaveAttribute('data-sla-state', 'breached');
  });

  it('summarises totals and overdue count in the header', () => {
    setup();
    const header = screen.getByRole('button', { name: /Paused & follow-up/ });
    expect(header).toHaveTextContent('1');
    expect(header).toHaveTextContent('1 overdue');
    expect(header).toHaveAttribute('aria-expanded', 'true');
  });

  it('is collapsed when empty, and can be toggled open by hand', () => {
    setup({ jobsByStatus: emptyWorkflowBuckets() as unknown as JobWorkflowBoardProps['jobsByStatus'], holdsByJob: new Map() });
    expect(screen.queryByTestId('workflow-column-on_hold')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Paused & follow-up/ }));
    expect(screen.getByTestId('workflow-column-on_hold')).toBeInTheDocument();
    expect(screen.getAllByText('Drop a job here')).toHaveLength(5);
  });

  it('auto-opens while a card is being dragged so it is always a drop target', () => {
    setup({ jobsByStatus: emptyWorkflowBuckets() as unknown as JobWorkflowBoardProps['jobsByStatus'], holdsByJob: new Map(), draggingId: 'x' });
    expect(screen.getByTestId('workflow-column-on_hold')).toBeInTheDocument();
  });

  it('forwards drag/drop and click events with the right status/job', () => {
    const p = setup();
    const target = screen.getByTestId('workflow-column-on_hold');
    fireEvent.dragOver(target);
    fireEvent.drop(target);
    expect(p.onDragOver).toHaveBeenCalledWith(expect.anything(), 'on_hold');
    expect(p.onDrop).toHaveBeenCalledWith(expect.anything(), 'on_hold');
    fireEvent.click(screen.getByText('Ann Lee'));
    expect(p.onOpenJob).toHaveBeenCalledWith(expect.objectContaining({ id: 'j1' }));
    fireEvent.dragStart(screen.getByText('Ann Lee'));
    expect(p.onCardDragStart).toHaveBeenCalled();
  });

  it('does not crash for a job with no hold record', () => {
    setup({ holdsByJob: new Map() });
    expect(screen.getByText('Ann Lee')).toBeInTheDocument();
  });
});
