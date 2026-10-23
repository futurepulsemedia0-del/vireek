import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ProjectPhase } from '@/lib/installProjects';
import type { PhaseDependency } from '@/lib/projectScheduler';
import { GanttChart } from './GanttChart';

const phase = (id: string, order: number, over: Partial<ProjectPhase> = {}): ProjectPhase => ({
  id, project_id: 'p', name: `Phase ${id}`, description: null, sort_order: order, weight: 1, status: 'not_started',
  planned_start: null, planned_end: null, actual_start: null, actual_end: null, locked: false, ...over,
});
const dep: PhaseDependency = { id: 'd1', project_id: 'p', predecessor_id: 'a', successor_id: 'b', dep_type: 'FS', lag_days: 0 };
const WEEK = { workWeekends: false };

// 2027-03-01 is a Monday.
const phases = () => [phase('a', 0, { planned_start: '2027-03-01', planned_end: '2027-03-03' }), phase('b', 1, { planned_start: '2027-03-04', planned_end: '2027-03-05' }), phase('c', 2)];
const base = { dependencies: [dep], cal: WEEK, today: '2027-03-02', zoom: 'day' as const, progress: new Map([['a', 40]]), onCommit: vi.fn() };

describe('GanttChart', () => {
  it('renders a focusable bar per dated phase with a descriptive label', () => {
    render(<GanttChart {...base} phases={phases()} />);
    const bar = screen.getByRole('button', { name: /Phase a, Mar 1, 2027 to Mar 3, 2027, 40% complete/ });
    expect(bar).toHaveAttribute('tabindex', '0');
  });

  it('offers a way to set dates for unscheduled phases', () => {
    const onOpen = vi.fn();
    render(<GanttChart {...base} phases={phases()} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: /No dates — click to set/ }));
    expect(onOpen).toHaveBeenCalledWith('c');
  });

  it('moves a phase with the arrow keys and pushes its successor', () => {
    const onCommit = vi.fn();
    render(<GanttChart {...base} phases={phases()} onCommit={onCommit} />);
    fireEvent.keyDown(screen.getByTestId('bar-a'), { key: 'ArrowRight', shiftKey: true });
    const [res, id] = onCommit.mock.calls[0];
    expect(id).toBe('a');
    expect(res.changes.map((c: { id: string }) => c.id)).toEqual(['a', 'b']);
    expect(res.windows.get('a')).toEqual({ start: '2027-03-08', end: '2027-03-10' });
  });

  it('changes only the end date with Alt + arrow', () => {
    const onCommit = vi.fn();
    render(<GanttChart {...base} phases={phases()} onCommit={onCommit} />);
    fireEvent.keyDown(screen.getByTestId('bar-b'), { key: 'ArrowRight', altKey: true });
    expect(onCommit.mock.calls[0][0].windows.get('b')).toEqual({ start: '2027-03-04', end: '2027-03-08' });
  });

  it('reports a blocked result for locked phases and ignores keys when read-only', () => {
    const onCommit = vi.fn();
    const locked = [phase('a', 0, { planned_start: '2027-03-01', planned_end: '2027-03-03', locked: true })];
    const { rerender } = render(<GanttChart {...base} phases={locked} dependencies={[]} onCommit={onCommit} />);
    fireEvent.keyDown(screen.getByTestId('bar-a'), { key: 'ArrowRight' });
    expect(onCommit.mock.calls[0][0].blocked).toBe('locked');
    onCommit.mockClear();
    rerender(<GanttChart {...base} phases={phases()} readOnly onCommit={onCommit} />);
    fireEvent.keyDown(screen.getByTestId('bar-a'), { key: 'ArrowRight' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('opens the editor with Enter and flags conflicts and the critical path', () => {
    const onOpen = vi.fn();
    render(<GanttChart {...base} phases={phases()} onOpen={onOpen} showCritical critical={new Map([['a', { es: '', ef: '', ls: '', lf: '', floatDays: 0, critical: true }]])} conflicts={new Map([['b', 'error' as const]])} />);
    expect(screen.getByRole('button', { name: /Phase a.*on the critical path/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Phase b.*has scheduling errors/ })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId('bar-a'), { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('a');
  });
});
