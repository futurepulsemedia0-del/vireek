import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent, CompiledRun, CompiledWorkflow } from '@/lib/workflowCompiler';
import RunDebugger from './RunDebugger';

const startTestRun = vi.fn(async () => 'run-2');
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/workflowCompiler', async (orig) => ({ ...(await orig<typeof import('@/lib/workflowCompiler')>()), startTestRun }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const ev = (seq: number, event_type: string, node_id: string | null, detail: Record<string, unknown> = {}): AuditEvent =>
  ({ id: seq, run_id: 'r1', seq, event_type, node_id, detail, hash: 'h', created_at: '2026-11-01T00:00:00Z' });

const wf = {
  id: 'w1', name: 'Emergency AC', trigger_event: 'call.emergency',
  graph: { entry: 'a', nodes: { a: { kind: 'lookup', label: 'Find customer' }, b: { kind: 'action', label: 'Notify owner' } }, edges: { a: { next: 'b' }, b: {} } },
} as unknown as CompiledWorkflow;
const run = { id: 'r1', workflow_id: 'w1', customer_name: 'Sam', state: { trigger: { summary: 'AC is dead' } } } as unknown as CompiledRun;
const events = [
  ev(1, 'node_started', 'a'),
  ev(2, 'edge_taken', 'a', { edge: 'next', customer_phone: '+1 555 123 4567', note: 'call +1 555 123 4567 or a@b.com' }),
  ev(3, 'node_started', 'b'),
];

describe('RunDebugger', () => {
  beforeEach(() => startTestRun.mockClear());
  const open = () => {
    render(<RunDebugger run={run} wf={wf} events={events} renderGraph={(o) => <p data-testid="overlay">{[...o].map(([k, v]) => `${k}:${v}`).join(',')}</p>} />);
    fireEvent.click(screen.getByRole('button', { name: 'Step through this run' }));
  };

  it('scrubs through events and the overlay follows', () => {
    open();
    expect(screen.getByText('Event 3 of 3')).toBeTruthy();
    expect(screen.getByTestId('overlay').textContent).toBe('a:done,b:active');
    fireEvent.change(screen.getByRole('slider', { name: 'Scrub through run events' }), { target: { value: '0' } });
    expect(screen.getByText('Event 1 of 3')).toBeTruthy();
    expect(screen.getByTestId('overlay').textContent).toBe('a:active');
    fireEvent.click(screen.getByRole('button', { name: 'Next event' }));
    expect(screen.getByText('Event 2 of 3')).toBeTruthy();
  });

  it('never shows phone numbers, emails or secret-looking fields', () => {
    open();
    fireEvent.change(screen.getByRole('slider', { name: 'Scrub through run events' }), { target: { value: '1' } });
    const details = screen.getByLabelText('Event details (sensitive values hidden)').textContent ?? '';
    expect(details).not.toMatch(/555|a@b\.com/);
    expect(details).toContain('[redacted]');
  });

  it('starts a new TEST run with the edited input and leaves the original alone', async () => {
    open();
    const start = screen.getByRole('button', { name: /Start test run with this input/ });
    fireEvent.change(screen.getByLabelText('What the customer said'), { target: { value: 'Heater is leaking' } });
    fireEvent.click(start);
    await waitFor(() => expect(startTestRun).toHaveBeenCalledTimes(1));
    expect(startTestRun).toHaveBeenCalledWith('w1', { summary: 'Heater is leaking', is_emergency: true, caller_name: 'Sam' }, 'Sam', '');
  });

  it('disables the what-if until there is input', () => {
    open();
    fireEvent.change(screen.getByLabelText('What the customer said'), { target: { value: '   ' } });
    expect((screen.getByRole('button', { name: /Start test run with this input/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
