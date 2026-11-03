import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { FixCard } from '@/components/agentReadiness/FixCard';
import type { Fix, FixAction } from '@/lib/agentReadinessCore';

const fix: Fix = {
  key: 'service_descriptions', kind: 'apply', ruleIds: ['services_described'], impact: 8, notes: ['templated_draft'],
  diff: [{ id: 'a', label: 'Drain cleaning', before: '', after: 'Drain cleaning for homes.' }, { id: 'b', label: 'Water heater', before: '', after: 'Water heater service.' }],
};
const setup = (actions: FixAction[] = [], canManage = true) => {
  const h = { onApprove: vi.fn(), onSkip: vi.fn(), onUndo: vi.fn() };
  render(<MemoryRouter><FixCard fix={fix} actions={actions} canManage={canManage} busy={false} {...h} /></MemoryRouter>);
  return h;
};

describe('FixCard', () => {
  it('shows before/after, approves only the selected rows', () => {
    const h = setup();
    expect(screen.getAllByText('Drain cleaning for homes.').length).toBe(1);
    fireEvent.click(screen.getByRole('checkbox', { name: /water heater/i }));
    fireEvent.click(screen.getByRole('button', { name: /approve selected/i }));
    expect(h.onApprove).toHaveBeenCalledWith(fix, ['a']);
  });
  it('skip calls back; undo is offered for an applied action and applied rows are not offered again', () => {
    const h = setup([{ id: 'act1', scan_id: 's', fix_key: 'service_descriptions', status: 'applied', changes: [fix.diff![0]] }]);
    expect(screen.queryByRole('checkbox', { name: /drain cleaning/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    expect(h.onUndo).toHaveBeenCalledWith('act1');
    fireEvent.click(screen.getByRole('button', { name: /^skip$/i }));
    expect(h.onSkip).toHaveBeenCalledWith(fix);
  });
  it('read-only members cannot approve, skip or undo', () => {
    setup([], false);
    expect(screen.getByRole('button', { name: /approve selected/i })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: /^skip$/i })).toHaveProperty('disabled', true);
  });
  it('a skipped fix hides the diff', () => {
    setup([{ id: 's1', scan_id: 's', fix_key: 'service_descriptions', status: 'skipped', changes: [] }]);
    expect(screen.queryByRole('button', { name: /approve selected/i })).toBeNull();
    expect(screen.getByText(/skipped/i)).toBeTruthy();
  });
});
