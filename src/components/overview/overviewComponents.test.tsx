import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';

// Deterministic i18n: supports both t(key, 'Default', vars) and t(key, { defaultValue, ...vars }).
vi.mock('react-i18next', () => {
  const fill = (s: string, v: Record<string, unknown> = {}) => s.replace(/{{\s*(\w+)\s*}}/g, (_, k: string) => String(v[k] ?? ''));
  const t = (key: string, a?: unknown, b?: unknown) => {
    if (typeof a === 'string') return fill(a, (b as Record<string, unknown>) ?? {});
    const o = (a ?? {}) as Record<string, unknown> & { defaultValue?: string; defaultValue_one?: string; defaultValue_other?: string; count?: number };
    const tpl = (o.count === 1 ? o.defaultValue_one : o.defaultValue_other) ?? o.defaultValue ?? key;
    return fill(tpl, o);
  };
  return { useTranslation: () => ({ t, i18n: { language: 'en', resolvedLanguage: 'en' } }) };
});

import { AttentionQueue, type AttentionEntry } from './AttentionQueue';
import { CallVolumeChart } from './CallVolumeChart';
import { RecentActivityList } from './RecentActivityList';

const entry = (over: Partial<AttentionEntry> = {}): AttentionEntry => ({
  id: 'a1', type: 'call', priority: 'urgent', title: 'Emergency call from Dana', description: 'Status: new lead.', ...over,
});

describe('AttentionQueue', () => {
  it('states clearly when nothing is waiting, with no icon and no action', () => {
    const { container } = render(<AttentionQueue items={[]} onAction={() => {}} />);
    expect(screen.getByText('Nothing is waiting on you right now.')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the count and one next action per row, wired to the entry', () => {
    const onAction = vi.fn();
    const items = [entry(), entry({ id: 'j1', type: 'job', priority: 'warning', title: 'Unassigned job: Lee' })];
    render(<AttentionQueue items={items} onAction={onAction} />);
    expect(screen.getByText('2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open jobs' }));
    expect(onAction).toHaveBeenCalledWith(items[1]);
    expect(screen.getByRole('button', { name: 'Open calls' })).toBeInTheDocument();
  });

  it('never relies on colour alone: every row has a priority word', () => {
    render(<AttentionQueue items={[entry(), entry({ id: 'x', priority: 'info', type: 'insight' })]} onAction={() => {}} />);
    expect(screen.getByText('Urgent')).toBeInTheDocument();
    expect(screen.getByText('For review')).toBeInTheDocument();
  });
});

describe('CallVolumeChart', () => {
  const data = [
    { date: '2026-10-01T00:00:00.000Z', count: 2 },
    { date: '2026-10-02T00:00:00.000Z', count: 9 },
    { date: '2026-10-03T00:00:00.000Z', count: 0 },
  ];

  it('renders an accessible chart with a zero baseline tick, the peak label and a table fallback', () => {
    const { container } = render(<CallVolumeChart data={data} />);
    expect(screen.getByRole('img')).toHaveAccessibleName(/11 in total/);
    const texts = Array.from(container.querySelectorAll('svg text')).map((n) => n.textContent);
    expect(texts).toContain('0');
    expect(texts.filter((t) => t === '9').length).toBeGreaterThanOrEqual(1); // peak direct label
    const table = container.querySelector('table') as HTMLElement;
    expect(within(table).getAllByRole('row')).toHaveLength(data.length + 1);
  });

  it('draws no bar for empty buckets and has no gradient or animation', () => {
    const { container } = render(<CallVolumeChart data={data} />);
    expect(container.querySelectorAll('svg rect[rx]')).toHaveLength(2);
    expect(container.innerHTML).not.toMatch(/gradient|animate|transition/i);
  });

  it('says so instead of drawing an empty chart', () => {
    const { container } = render(<CallVolumeChart data={[{ date: '2026-10-01T00:00:00.000Z', count: 0 }]} />);
    expect(screen.getByText('No calls in this period.')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders annotations only when events are provided and they fall inside a bucket', () => {
    const { container, rerender } = render(<CallVolumeChart data={data} />);
    expect(container.textContent).not.toContain('Storm');
    rerender(<CallVolumeChart data={data} events={[{ date: '2026-10-02T09:00:00.000Z', label: 'Storm' }, { date: '2025-01-01', label: 'Out of range' }]} />);
    expect(container.textContent).toContain('Storm');
    expect(container.textContent).not.toContain('Out of range');
  });
});

describe('RecentActivityList', () => {
  it('renders rows with machine-readable time and a quiet empty state', () => {
    const { rerender, container } = render(<RecentActivityList items={[]} />);
    expect(screen.getByText('Calls, jobs and leads show up here as they come in.')).toBeInTheDocument();
    rerender(<RecentActivityList items={[{ id: 'call-1', type: 'call', title: 'Call from Dana', description: 'Burst pipe', timestamp: '2026-10-02T10:00:00.000Z' }]} highlightId="call-1" />);
    expect(container.querySelector('time')).toHaveAttribute('datetime', '2026-10-02T10:00:00.000Z');
    expect(container.querySelector('li')?.className).toContain('bg-accent/5');
  });
});
