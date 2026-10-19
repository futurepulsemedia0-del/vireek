import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { DateRangeFilter } from './DateRangeFilter';
import { useDateRange } from '@/hooks/useDateRange';
import type { RangePreset } from '@/lib/dateRange';

// Vitest globals are off in this project, so RTL's auto-cleanup isn't registered.
afterEach(cleanup);

const seenStarts: Date[] = [];
function IdentityProbe({ start }: { start: Date }) {
  seenStarts.push(start);
  return null;
}

function Harness({ defaultPreset = '30d' }: { defaultPreset?: RangePreset }) {
  const controller = useDateRange(defaultPreset);
  const location = useLocation();
  return (
    <>
      <DateRangeFilter controller={controller} />
      <output data-testid="search">{location.search}</output>
      <output data-testid="preset">{controller.range.preset}</output>
      <output data-testid="compare">{String(controller.range.compare)}</output>
      <IdentityProbe start={controller.range.start} />
    </>
  );
}

const renderAt = (url = '/dashboard/analytics', defaultPreset: RangePreset = '30d') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Harness defaultPreset={defaultPreset} />
    </MemoryRouter>,
  );

const openPanel = () =>
  fireEvent.click(
    screen.getByRole('button', {
      name: /last 30 days|today|last 7 days|month to date|quarter to date|custom range|last 90 days/i,
    }),
  );

describe('DateRangeFilter', () => {
  it('starts from the page default with a clean URL and compare on', () => {
    renderAt();
    expect(screen.getByTestId('preset')).toHaveTextContent('30d');
    expect(screen.getByTestId('search')).toBeEmptyDOMElement();
    expect(screen.getByTestId('compare')).toHaveTextContent('true');
    expect(screen.getByRole('checkbox', { name: /compare to previous period/i })).toBeChecked();
  });

  it('reads the selection from the URL on load (shareable links)', () => {
    renderAt('/x?range=qtd&compare=0');
    expect(screen.getByTestId('preset')).toHaveTextContent('qtd');
    expect(screen.getByTestId('compare')).toHaveTextContent('false');
    expect(screen.getByRole('checkbox', { name: /compare to previous period/i })).not.toBeChecked();
  });

  it('writes a preset to the URL and closes the panel', () => {
    renderAt();
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Month to date' }));
    expect(screen.getByTestId('search')).toHaveTextContent('?range=mtd');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('preserves unrelated query params when the range changes', () => {
    renderAt('/x?tab=segments');
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    const search = screen.getByTestId('search').textContent ?? '';
    expect(search).toContain('tab=segments');
    expect(search).toContain('range=today');
  });

  it('marks the active preset with aria-pressed', () => {
    renderAt('/x?range=7d');
    openPanel();
    expect(screen.getByRole('button', { name: 'Last 7 days', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Today', pressed: false })).toBeInTheDocument();
  });

  it('toggles compare via the URL', () => {
    renderAt();
    fireEvent.click(screen.getByRole('checkbox', { name: /compare to previous period/i }));
    expect(screen.getByTestId('search')).toHaveTextContent('compare=0');
    fireEvent.click(screen.getByRole('checkbox', { name: /compare to previous period/i }));
    expect(screen.getByTestId('search')).toBeEmptyDOMElement();
  });

  it('applies a valid custom range', () => {
    renderAt();
    openPanel();
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-01-05' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-01-20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    const search = screen.getByTestId('search').textContent ?? '';
    expect(search).toContain('range=custom');
    expect(search).toContain('from=2026-01-05');
    expect(search).toContain('to=2026-01-20');
    expect(screen.getByTestId('preset')).toHaveTextContent('custom');
  });

  it('rejects a reversed custom range with an alert and leaves the URL alone', () => {
    renderAt();
    openPanel();
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-02-20' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-02-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/on or before/i);
    expect(screen.getByTestId('search')).toBeEmptyDOMElement();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('falls back to the default for a hand-edited, invalid URL', () => {
    renderAt('/x?range=custom&from=garbage&to=2026-01-01');
    expect(screen.getByTestId('preset')).toHaveTextContent('30d');
  });

  it('closes on Escape', () => {
    renderAt();
    openPanel();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('respects a non-30d page default (no ?range= needed for it)', () => {
    renderAt('/x', 'mtd');
    expect(screen.getByTestId('preset')).toHaveTextContent('mtd');
    expect(screen.getByTestId('search')).toBeEmptyDOMElement();
  });

  it('keeps the same Date objects when only compare is toggled (no refetch storms)', () => {
    seenStarts.length = 0;
    renderAt();
    fireEvent.click(screen.getByRole('checkbox', { name: /compare to previous period/i }));
    expect(screen.getByTestId('compare')).toHaveTextContent('false');
    expect(new Set(seenStarts).size).toBe(1);
  });
});
