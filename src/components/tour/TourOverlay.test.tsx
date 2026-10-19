import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TourStep } from '@/lib/productTours';
import { TourOverlay, findVisibleTarget } from './TourOverlay';

vi.mock('react-i18next', async () => (await import('@/test/i18nMock')).reactI18nextMock);

const STEPS: TourStep[] = [
  { id: 'a', title: 'First', body: 'Body A' },
  { id: 'b', title: 'Second', body: 'Body B', targets: ['[data-tour="missing"]'], optional: true },
  { id: 'c', title: 'Third', body: 'Body C' },
];

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function Harness({
  steps = STEPS, finishCta, onPause = vi.fn(), onSkip = vi.fn(), onFinish = vi.fn(), start = '/dashboard',
}: {
  steps?: TourStep[]; finishCta?: { label: string; href: string };
  onPause?: () => void; onSkip?: () => void; onFinish?: () => void; start?: string;
}) {
  const [index, setIndex] = useState(0);
  return (
    <MemoryRouter initialEntries={[start]}>
      <TourOverlay
        tourId="owner" steps={steps} index={index} finishCta={finishCta}
        onStep={setIndex} onPause={onPause} onSkip={onSkip} onFinish={onFinish}
      />
      <Where />
    </MemoryRouter>
  );
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('TourOverlay', () => {
  it('renders an accessible modal dialog with a step counter', () => {
    render(<Harness />);
    const dialog = screen.getByRole('dialog', { name: 'First' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getAllByText(/Step 1 of 3/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Previous step' })).not.toBeInTheDocument();
  });

  it('navigates forward and back, including with the keyboard', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('dialog', { name: 'Second' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Previous step' }));
    expect(screen.getByRole('dialog', { name: 'First' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(screen.getByRole('dialog', { name: 'Second' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(screen.getByRole('dialog', { name: 'First' })).toBeInTheDocument();
  });

  it('Escape and ✕ pause (progress is kept), Skip skips', () => {
    const onPause = vi.fn();
    const onSkip = vi.fn();
    render(<Harness onPause={onPause} onSkip={onSkip} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onPause).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /close tour/i }));
    expect(onPause).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('finishes, then follows the finish link', () => {
    const onFinish = vi.fn();
    render(<Harness onFinish={onFinish} finishCta={{ label: 'Open checklist', href: '/dashboard/getting-started' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open checklist' }));
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('where')).toHaveTextContent('/dashboard/getting-started');
  });

  it('shows "Done" when there is no finish link', () => {
    render(<Harness steps={[STEPS[0]]} />);
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('auto-skips an optional step whose target never appears', () => {
    vi.useFakeTimers();
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('dialog', { name: 'Second' })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByRole('dialog', { name: 'Third' })).toBeInTheDocument();
  });

  it('spotlights a visible target', async () => {
    const el = document.createElement('button');
    el.setAttribute('data-tour', 'probe');
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      top: 100, left: 100, width: 120, height: 40, right: 220, bottom: 140, x: 100, y: 100, toJSON: () => ({}),
    } as DOMRect);
    document.body.appendChild(el);
    render(<Harness steps={[{ id: 'p', title: 'Probe', body: 'x', targets: ['[data-tour="probe"]'] }]} />);
    expect(await screen.findByTestId('tour-spotlight')).toBeInTheDocument();
  });

  it('navigates to the route a step belongs to', () => {
    render(<Harness steps={[{ id: 'r', title: 'Route', body: 'x', route: '/tech/today' }]} start="/dashboard" />);
    expect(screen.getByTestId('where')).toHaveTextContent('/tech/today');
  });

  it('interpolates the platform shortcut key into the copy', () => {
    render(<Harness steps={[{ id: 's', title: 'Search', body: 'Press {{mod}} + K' }]} />);
    expect(screen.getByText(/Press (⌘|Ctrl) \+ K/)).toBeInTheDocument();
  });
});

describe('findVisibleTarget', () => {
  it('ignores hidden matches, falls through selectors, and survives invalid selectors', () => {
    const hidden = document.createElement('a');
    hidden.className = 'nav';
    const shown = document.createElement('button');
    shown.id = 'menu';
    vi.spyOn(shown, 'getBoundingClientRect').mockReturnValue({ width: 10, height: 10 } as DOMRect);
    document.body.append(hidden, shown);
    expect(findVisibleTarget(['a[[bad', 'a.nav', '#menu'])).toBe(shown);
    expect(findVisibleTarget(['a.nav'])).toBeNull();
    expect(findVisibleTarget(undefined)).toBeNull();
  });
});
