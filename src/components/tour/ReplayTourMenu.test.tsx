import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TOURS } from '@/lib/productTours';
import { ReplayTourMenu } from './ReplayTourMenu';

vi.mock('react-i18next', async () => (await import('@/test/i18nMock')).reactI18nextMock);

const ctx = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@/contexts/ProductTourContext', () => ({ useProductTour: () => ctx.value }));

const startTour = vi.fn();
const replayTour = vi.fn();
const resetTips = vi.fn();

beforeEach(() => {
  [startTour, replayTour, resetTips].forEach((f) => f.mockClear());
  ctx.value = {
    role: 'owner', tour: TOURS.owner, status: 'not_started', stepIndex: 0, stepCount: 11,
    completedAt: null, isActive: false, startTour, replayTour, dismissedTipCount: 2, resetTips,
  };
});

const open = () => {
  render(
    <MemoryRouter>
      <ReplayTourMenu />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: /help and product tour/i }));
};

describe('ReplayTourMenu', () => {
  it('renders nothing when the viewer has no tour', () => {
    ctx.value = { ...ctx.value, tour: null, role: null };
    const { container } = render(
      <MemoryRouter>
        <ReplayTourMenu />
      </MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('first run: offers "Take the tour" and starts it', () => {
    open();
    expect(screen.getByText('Not started')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: /take the tour/i }));
    expect(startTour).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('paused: shows progress, offers resume and restart', () => {
    ctx.value = { ...ctx.value, status: 'in_progress', stepIndex: 2, stepCount: 8 };
    open();
    expect(screen.getByText('In progress — step 3 of 8')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: /resume tour/i }));
    expect(startTour).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /help and product tour/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /restart from the beginning/i }));
    expect(replayTour).toHaveBeenCalledTimes(1);
  });

  it('completed: shows the date and offers replay', () => {
    ctx.value = { ...ctx.value, status: 'completed', completedAt: '2026-10-18T10:00:00.000Z' };
    open();
    expect(screen.getByText(/^Completed /)).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /restart/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: /replay tour/i }));
    expect(startTour).toHaveBeenCalledTimes(1);
  });

  it('skipped tours can be replayed', () => {
    ctx.value = { ...ctx.value, status: 'skipped' };
    open();
    expect(screen.getByText('Skipped')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /replay tour/i })).toBeInTheDocument();
  });

  it('resets tips, and disables the action when none were dismissed', () => {
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: /show tips again/i }));
    expect(resetTips).toHaveBeenCalledTimes(1);
  });

  it('disables "show tips again" with nothing to restore', () => {
    ctx.value = { ...ctx.value, dismissedTipCount: 0 };
    open();
    expect(screen.getByRole('menuitem', { name: /show tips again/i })).toBeDisabled();
  });

  it('technicians do not get the dashboard checklist link', () => {
    ctx.value = { ...ctx.value, role: 'technician', tour: TOURS.technician };
    open();
    expect(screen.queryByRole('menuitem', { name: /setup checklist/i })).not.toBeInTheDocument();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    open();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /help and product tour/i })).toHaveFocus();
  });

  it('exposes the stable data-tour hook used by the tour', () => {
    render(
      <MemoryRouter>
        <ReplayTourMenu />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: /help and product tour/i })).toHaveAttribute('data-tour', 'tour-menu');
  });
});
