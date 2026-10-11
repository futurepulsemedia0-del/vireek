import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { OverviewGrid } from './OverviewGrid';
import type { LayoutItem } from '@/lib/overviewLayout';

const items: LayoutItem[] = [
  { id: 'kpi_calls', w: 3, h: 0, hidden: false },
  { id: 'attribution', w: 12, h: 0, hidden: false },
  { id: 'quick_actions', w: 12, h: 3, hidden: false },
];

const renderWidget = (id: string) => (id === 'attribution' ? null : <div>content-{id}</div>);

const handlers = () => ({ onMove: vi.fn(), onMoveBy: vi.fn(), onResize: vi.fn(), onHide: vi.fn() });

afterEach(cleanup);

describe('OverviewGrid', () => {
  it('renders widgets and skips ones with no content outside edit mode', () => {
    render(<OverviewGrid items={items} editing={false} renderWidget={renderWidget} {...handlers()} />);
    expect(screen.getByText('content-kpi_calls')).toBeInTheDocument();
    expect(screen.queryByText(/appears here once there is data/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hide/ })).not.toBeInTheDocument();
  });

  it('applies a fixed height in row units', () => {
    const { container } = render(<OverviewGrid items={items} editing={false} renderWidget={renderWidget} {...handlers()} />);
    const el = container.querySelector<HTMLElement>('[data-overview-widget="quick_actions"]')!;
    expect(el.style.height).toBe('240px');
  });

  it('shows a placeholder and edit controls in edit mode', () => {
    render(<OverviewGrid items={items} editing renderWidget={renderWidget} {...handlers()} />);
    expect(screen.getByText(/lead source attribution appears here/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Hide / })).toHaveLength(3);
  });

  it('hides a widget from its control', () => {
    const h = handlers();
    render(<OverviewGrid items={items} editing renderWidget={renderWidget} {...h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide Calls this month' }));
    expect(h.onHide).toHaveBeenCalledWith('kpi_calls');
  });

  it('moves with the keyboard and announces it', () => {
    const h = handlers();
    render(<OverviewGrid items={items} editing renderWidget={renderWidget} {...h} />);
    const handle = screen.getByRole('button', { name: /^Move Calls this month/ });
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(h.onMoveBy).toHaveBeenCalledWith('kpi_calls', 1);
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(h.onMoveBy).toHaveBeenCalledWith('kpi_calls', -1);
    expect(screen.getByRole('status')).toHaveTextContent(/moved earlier/i);
  });

  it('resizes with the keyboard', () => {
    const h = handlers();
    render(<OverviewGrid items={items} editing renderWidget={renderWidget} {...h} />);
    const handle = screen.getByRole('button', { name: /^Resize Calls this month/ });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(h.onResize).toHaveBeenCalledWith('kpi_calls', { w: 4 });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(h.onResize).toHaveBeenCalledWith('kpi_calls', { w: 2 });
  });

  it('shows skeletons while loading', () => {
    const { container } = render(<OverviewGrid items={items} editing={false} loading renderWidget={renderWidget} {...handlers()} />);
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    expect(screen.queryByText('content-kpi_calls')).not.toBeInTheDocument();
  });
});
