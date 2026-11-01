import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ErrorPanel } from './ErrorPanel';
import { BulkResultPanel } from './BulkResultPanel';
import { EmptyState } from '@/components/EmptyState';
import { classifyError } from '@/lib/trust/appError';
import { Inbox } from 'lucide-react';

vi.mock('react-i18next', async () => (await import('@/test/i18nMock')).reactI18nextMock);

describe('ErrorPanel', () => {
  it('shows the localized message, the reference id and never the raw text', () => {
    const err = classifyError({ code: '42501', message: 'permission denied for table secret' }, { offline: false });
    render(<ErrorPanel error={err} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(err.referenceId)).toBeInTheDocument();
    expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /contact support/i })).toHaveAttribute('href', expect.stringContaining(encodeURIComponent(err.referenceId)));
  });
  it('offers Retry for transient errors and calls it', () => {
    const onRetry = vi.fn();
    render(<ErrorPanel error={classifyError({ status: 503 }, { offline: false })} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
  it('auth errors offer Sign in again', () => {
    const onSignIn = vi.fn();
    render(<ErrorPanel error={classifyError({ status: 401 }, { offline: false })} onSignIn={onSignIn} />);
    fireEvent.click(screen.getByRole('button', { name: /sign in again/i }));
    expect(onSignIn).toHaveBeenCalledOnce();
  });
});

describe('BulkResultPanel', () => {
  const result = { requested: 5, succeeded: ['a', 'b'], failed: [{ id: 'c', reason: 'Failed to fetch' }], skipped: [{ id: 'd', reason: 'Already invoiced.' }] };
  it('summarises, expands reasons, retries failed only', async () => {
    const onRetryFailed = vi.fn().mockResolvedValue(undefined);
    render(<BulkResultPanel result={result} onRetryFailed={onRetryFailed} onDismiss={vi.fn()} />);
    expect(screen.getByText('2 succeeded, 1 failed, 1 skipped')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /show reasons/i }));
    expect(screen.getByText(/Already invoiced\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry failed only/i }));
    await waitFor(() => expect(onRetryFailed).toHaveBeenCalledOnce());
  });
  it('hides Retry when nothing failed', () => {
    render(<BulkResultPanel result={{ ...result, failed: [] }} onRetryFailed={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /retry failed only/i })).not.toBeInTheDocument();
  });
});

describe('EmptyState variants', () => {
  it('no-results turns onClearFilters into the primary button', () => {
    const clear = vi.fn();
    render(<EmptyState icon={Inbox} title="No jobs" variant="no-results" onClearFilters={clear} />);
    fireEvent.click(screen.getByRole('button', { name: /clear filters/i }));
    expect(clear).toHaveBeenCalledOnce();
  });
  it('no-permission has no primary button; load-failed is an alert with retry', () => {
    const { unmount } = render(<EmptyState icon={Inbox} title="Nope" variant="no-permission" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    unmount();
    const retry = vi.fn();
    render(<EmptyState icon={Inbox} title="Failed" variant="load-failed" onRetry={retry} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(retry).toHaveBeenCalledOnce();
  });
  it('renders a secondary Learn more link safely', () => {
    render(<EmptyState icon={Inbox} title="Empty" learnMore={{ href: '/help/x' }} />);
    const a = screen.getByRole('link', { name: /learn more/i });
    expect(a).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });
});
