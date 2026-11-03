import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Panel } from './Panel';
import { PageHeader } from './PageHeader';
import { Stat, Sparkline } from './Stat';
import { StatusDot } from './StatusDot';

describe('Panel', () => {
  it('renders a hairline container with no shadow or large radius', () => {
    render(<Panel title="Needs attention" data-testid="p">body</Panel>);
    const el = screen.getByTestId('p');
    expect(el.className).toContain('border-border');
    expect(el.className).not.toMatch(/shadow|rounded-(2xl|3xl)/);
    expect(screen.getByRole('heading', { level: 2, name: 'Needs attention' })).toBeInTheDocument();
  });

  it('omits the header when neither title nor actions are given', () => {
    render(<Panel>only body</Panel>);
    expect(screen.queryByRole('heading')).toBeNull();
  });
});

describe('PageHeader', () => {
  it('renders title, context and the primary action', () => {
    render(<PageHeader title="Overview" context="Last 30 days" primaryAction={<button>New job</button>} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByText('Last 30 days')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New job' })).toBeInTheDocument();
  });
});

describe('Stat', () => {
  it('exposes the definition to assistive tech and is keyboard focusable', () => {
    render(<Stat label="Calls answered" value="94%" definition="Answered calls divided by all inbound calls." />);
    const tile = screen.getByText('Calls answered').closest('div[tabindex]') as HTMLElement;
    expect(tile).not.toBeNull();
    expect(tile).toHaveAttribute('aria-describedby');
    expect(screen.getByText('Answered calls divided by all inbound calls.')).toHaveClass('sr-only');
  });

  it('marks itself busy while loading and keeps the value visible', () => {
    render(<Stat label="Revenue" value="$12,400" loading />);
    expect(screen.getByText('$12,400').closest('[aria-busy]')).toHaveAttribute('aria-busy', 'true');
  });

  it('uses tabular numerals and renders no icon', () => {
    const { container } = render(<Stat label="Jobs" value="18" />);
    expect(screen.getByText('18').className).toContain('tabular-nums');
    expect(container.querySelector('svg')).toBeNull();
  });
});

describe('Sparkline', () => {
  it('renders nothing for fewer than two finite points', () => {
    const { container } = render(<Sparkline values={[3, Number.NaN]} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('is decorative (aria-hidden) and draws a path', () => {
    const { container } = render(<Sparkline values={[1, 3, 2, 5]} />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg.querySelector('path')?.getAttribute('d')).toMatch(/^M/);
  });

  it('does not divide by zero on a flat series', () => {
    const { container } = render(<Sparkline values={[4, 4, 4]} />);
    expect(container.querySelector('path')?.getAttribute('d')).not.toMatch(/NaN|Infinity/);
  });
});

describe('StatusDot', () => {
  it('always carries a text label (colour is never the only signal)', () => {
    render(<StatusDot tone="danger" label="Overdue" />);
    expect(screen.getByText('Overdue')).toBeInTheDocument();
  });
});
