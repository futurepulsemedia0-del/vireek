import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { BlockingOverlay, LoadingBoundary, Progress, SkeletonBlock, useLoading } from '@/components/loading';
import { Button } from '@/components/ui/Button';

const tick = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Progress', () => {
  it('exposes a real value only when determinate', () => {
    const { rerender } = render(<Progress label="Upload" value={42} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
    rerender(<Progress label="Upload" />);
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  });
  it('clamps out-of-range values', () => {
    render(<Progress label="Upload" value={250} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });
});

describe('Button loading', () => {
  it('blocks clicks, is busy immediately, shows the spinner after 150ms', async () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Save</Button>);
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
    expect(btn.querySelector('.vrk-spin')).toBeNull();
    await tick(150);
    expect(btn.querySelector('.vrk-spin')).not.toBeNull();
    expect(btn).toHaveTextContent('Save'); // label stays in the DOM: width is preserved
  });
});

describe('LoadingBoundary', () => {
  const skeleton = <SkeletonBlock className="h-10" />;
  it('renders content when idle', () => {
    render(<LoadingBoundary isLoading={false} skeleton={skeleton}><p>Data</p></LoadingBoundary>);
    expect(screen.getByText('Data')).toBeInTheDocument();
  });
  it('reserves space invisibly for 150ms, then shows the skeleton', async () => {
    const { container } = render(<LoadingBoundary isLoading skeleton={skeleton}><p>Data</p></LoadingBoundary>);
    expect(container.querySelector('.invisible')).not.toBeNull();
    await tick(150);
    expect(container.querySelector('.vrk-fade-in')).not.toBeNull();
    expect(screen.queryByText('Data')).toBeNull();
  });
  it('shows error with retry, and empty state', () => {
    const onRetry = vi.fn();
    const { rerender } = render(<LoadingBoundary isLoading={false} error={new Error('x')} onRetry={onRetry} skeleton={skeleton}>x</LoadingBoundary>);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    expect(onRetry).toHaveBeenCalledOnce();
    rerender(<LoadingBoundary isLoading={false} isEmpty empty={<p>Nothing</p>} skeleton={skeleton}>x</LoadingBoundary>);
    expect(screen.getByText('Nothing')).toBeInTheDocument();
  });
  it('turns into a timeout error after timeoutMs', async () => {
    render(<LoadingBoundary isLoading timeoutMs={1000} onRetry={() => {}} skeleton={skeleton}>x</LoadingBoundary>);
    await tick(1000);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

describe('BlockingOverlay', () => {
  it('blocks and traps focus from the first frame, holds 400ms after being shown', async () => {
    const { rerender } = render(<BlockingOverlay open label="Paying" />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(document.activeElement).toBe(dialog);
    expect(document.body.style.overflow).toBe('hidden');
    await tick(150); // visuals appear
    rerender(<BlockingOverlay open={false} label="Paying" />);
    await tick(300);
    expect(screen.queryByRole('dialog')).not.toBeNull();
    await tick(150);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });
});

describe('useLoading', () => {
  it('tracks overlapping runs and never throws', async () => {
    const { result } = renderHook(() => useLoading());
    let outcome: unknown;
    await act(async () => {
      const a = result.current.run(async () => 1);
      const b = result.current.run(async () => { throw new Error('boom'); });
      outcome = await a;
      await b;
    });
    expect(outcome).toEqual({ ok: true, value: 1 });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeInstanceOf(Error);
  });
});
