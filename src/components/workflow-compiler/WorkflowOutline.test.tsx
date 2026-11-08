import { render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import type { CompiledWorkflow } from '@/lib/workflowCompiler';
import WorkflowOutline from './WorkflowOutline';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const node = (kind: string, label: string) => ({ kind, label });
const wf = {
  id: 'w1', name: 'Emergency AC',
  graph: {
    entry: 'c1',
    nodes: { c1: node('lookup', 'Find customer'), p: node('parallel', 'Check both'), t0: node('lookup', 'Techs'), t1: node('lookup', 'Parts'), j: node('join', 'Wait for both'), each: node('action', 'Text one tech') },
    edges: { c1: { next: 'p' }, p: { b0: 't0', b1: 't1' }, t0: { next: 'j' }, t1: { next: 'j' }, j: {}, each: {} },
  },
} as unknown as CompiledWorkflow;

describe('WorkflowOutline', () => {
  it('lists steps in flow order with readable connections and anchors between them', () => {
    render(<WorkflowOutline wf={wf} />);
    const nav = screen.getByRole('navigation', { name: 'Step outline for Emergency AC' });
    const text = nav.textContent ?? '';
    expect(text.indexOf('Find customer')).toBeLessThan(text.indexOf('Check both'));
    expect(text.indexOf('Check both')).toBeLessThan(text.indexOf('Wait for both'));
    expect(text).toContain('branch 1');
    expect(text).toContain('branch 2');
    const link = within(nav).getAllByRole('link', { name: 'Techs' })[0];
    expect(link.getAttribute('href')).toBe('#outline-t0');
  });

  it('lists fan-out bodies and undo steps separately as side steps', () => {
    render(<WorkflowOutline wf={wf} />);
    expect(screen.getByRole('heading', { name: 'Side steps' })).toBeTruthy();
    expect(screen.getByText(/Text one tech/)).toBeTruthy();
  });

  it('states run progress as text, not colour alone', () => {
    render(<WorkflowOutline wf={wf} overlay={new Map([['c1', 'done'], ['p', 'active']] as const)} />);
    expect(screen.getByText(/— done/)).toBeTruthy();
    expect(screen.getByText(/— running/)).toBeTruthy();
  });

  it('has no axe violations (colour contrast is checked in the browser suite, jsdom cannot)', async () => {
    const { container } = render(<WorkflowOutline wf={wf} overlay={new Map([['c1', 'done']] as const)} />);
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
