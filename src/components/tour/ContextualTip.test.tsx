import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextualTip } from './ContextualTip';

vi.mock('react-i18next', async () => (await import('@/test/i18nMock')).reactI18nextMock);

const ctx = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@/contexts/ProductTourContext', () => ({ useProductTour: () => ctx.value }));

const dismissTip = vi.fn();

beforeEach(() => {
  dismissTip.mockClear();
  ctx.value = { role: 'owner', tipsEnabled: true, isTipDismissed: () => false, dismissTip };
});

const renderTip = (id: 'jobs.create' | 'tech.timesheet' = 'jobs.create') =>
  render(
    <ContextualTip id={id}>
      <button>Target</button>
    </ContextualTip>,
  );

describe('ContextualTip', () => {
  it('shows a beacon next to the child and reveals the tip on click', () => {
    renderTip();
    expect(screen.getByRole('button', { name: 'Target' })).toBeInTheDocument();
    const beacon = screen.getByRole('button', { name: /tip: create your first job/i });
    expect(beacon).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(beacon);
    expect(beacon).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog', { name: 'Create your first job' })).toBeInTheDocument();
  });

  it('"Got it" dismisses permanently and closes the popover', () => {
    renderTip();
    fireEvent.click(screen.getByRole('button', { name: /tip:/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(dismissTip).toHaveBeenCalledWith('jobs.create');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Escape closes without dismissing', () => {
    renderTip();
    fireEvent.click(screen.getByRole('button', { name: /tip:/i }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(dismissTip).not.toHaveBeenCalled();
  });

  it('renders only the child when tips are not enabled yet', () => {
    ctx.value = { ...ctx.value, tipsEnabled: false };
    renderTip();
    expect(screen.getByRole('button', { name: 'Target' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /tip:/i })).not.toBeInTheDocument();
  });

  it('renders only the child once dismissed', () => {
    ctx.value = { ...ctx.value, isTipDismissed: () => true };
    renderTip();
    expect(screen.queryByRole('button', { name: /tip:/i })).not.toBeInTheDocument();
  });

  it('respects per-role targeting', () => {
    renderTip('tech.timesheet');
    expect(screen.queryByRole('button', { name: /tip:/i })).not.toBeInTheDocument();
    ctx.value = { ...ctx.value, role: 'technician' };
    renderTip('tech.timesheet');
    expect(screen.getByRole('button', { name: /tip: track your hours/i })).toBeInTheDocument();
  });

  it('can be disabled by the caller', () => {
    render(
      <ContextualTip id="jobs.create" disabled>
        <button>Target</button>
      </ContextualTip>,
    );
    expect(screen.queryByRole('button', { name: /tip:/i })).not.toBeInTheDocument();
  });
});
