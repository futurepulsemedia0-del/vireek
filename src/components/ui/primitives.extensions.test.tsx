import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from './Button';
import { Card } from './Card';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonPage, SkeletonForm, SkeletonChart } from '@/components/Skeleton';

describe('Card padding', () => {
  it('defaults to p-8 (previous behaviour)', () => {
    render(<Card data-testid="c">x</Card>);
    expect(screen.getByTestId('c').className).toContain('p-8');
  });
  it('md renders p-6 and never p-8', () => {
    render(<Card data-testid="c" padding="md">x</Card>);
    const cls = screen.getByTestId('c').className;
    expect(cls).toContain('p-6');
    expect(cls).not.toContain('p-8');
  });
});

describe('Button fullWidth / tone', () => {
  it('adds w-full', () => {
    render(<Button fullWidth>Go</Button>);
    expect(screen.getByRole('button').className).toContain('w-full');
  });
  it('tone="cta" swaps bg-accent for bg-cta on primary only', () => {
    render(<><Button tone="cta">A</Button><Button variant="secondary" tone="cta">B</Button></>);
    const [a, b] = screen.getAllByRole('button');
    expect(a.className).toContain('bg-cta');
    expect(b.className).not.toContain('bg-cta');
  });
});

describe('EmptyState compact', () => {
  it('renders a single line without heading or icon', () => {
    render(<EmptyState compact title="No calls yet." />);
    expect(screen.getByText('No calls yet.')).toBeInTheDocument();
    expect(screen.queryByRole('heading')).toBeNull();
  });
  it('exposes load-failed as an alert', () => {
    render(<EmptyState compact variant="load-failed" title="Failed" />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

describe('Skeleton page/form/chart', () => {
  it('are busy status regions', () => {
    render(<><SkeletonPage /><SkeletonForm fields={2} /><SkeletonChart /></>);
    expect(screen.getAllByRole('status')).toHaveLength(3);
  });
});
