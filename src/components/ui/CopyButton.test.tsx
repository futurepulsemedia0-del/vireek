import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { reactI18nextMock } from '@/test/i18nMock';

vi.mock('react-i18next', () => reactI18nextMock);
const announce = vi.fn();
vi.mock('@/lib/a11y/announcer', () => ({ announce: (...a: unknown[]) => announce(...a) }));

import { CopyButton } from './CopyButton';
import { writeClipboard } from '@/lib/clipboard';

const setClipboard = (value: unknown) => Object.defineProperty(navigator, 'clipboard', { value, configurable: true });

beforeEach(() => {
  announce.mockClear();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('writeClipboard', () => {
  it('uses navigator.clipboard when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    expect(await writeClipboard('abc')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('abc');
  });

  it('falls back to execCommand when the async API rejects', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    const exec = vi.fn().mockReturnValue(true);
    document.execCommand = exec;
    expect(await writeClipboard('abc')).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    expect(document.querySelectorAll('textarea')).toHaveLength(0); // cleaned up
  });

  it('falls back when navigator.clipboard is missing and reports false when both fail', async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn().mockReturnValue(false);
    expect(await writeClipboard('abc')).toBe(false);
  });

  it('restores focus to the previously focused element after the fallback', async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn().mockReturnValue(true);
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    btn.focus();
    await writeClipboard('x');
    expect(btn).toHaveFocus();
    btn.remove();
  });
});

describe('CopyButton', () => {
  it('shows inline confirmation, announces politely, then resets', async () => {
    setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
    render(<CopyButton text="secret" />);
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('data-copy-status', 'idle');
    await act(async () => void fireEvent.click(btn));
    expect(btn).toHaveAttribute('data-copy-status', 'copied');
    expect(btn).toHaveAccessibleName('Copied');
    expect(announce).toHaveBeenCalledWith('Copied', 'polite');
    act(() => void vi.advanceTimersByTime(2001));
    expect(btn).toHaveAttribute('data-copy-status', 'idle');
    expect(btn).toHaveAccessibleName('Copy');
  });

  it('rapid repeated clicks restart one timer and never leave it stuck', async () => {
    setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
    render(<CopyButton text="x" />);
    const btn = screen.getByRole('button');
    await act(async () => void fireEvent.click(btn));
    act(() => void vi.advanceTimersByTime(1500));
    await act(async () => void fireEvent.click(btn)); // restarts
    act(() => void vi.advanceTimersByTime(1500));
    expect(btn).toHaveAttribute('data-copy-status', 'copied');
    act(() => void vi.advanceTimersByTime(600));
    expect(btn).toHaveAttribute('data-copy-status', 'idle');
  });

  it('reports failure inline and assertively', async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn().mockReturnValue(false);
    render(<CopyButton text="x" />);
    const btn = screen.getByRole('button');
    await act(async () => void fireEvent.click(btn));
    expect(btn).toHaveAttribute('data-copy-status', 'failed');
    expect(announce).toHaveBeenCalledWith('Copy failed', 'assertive');
  });

  it('accepts a lazy text getter', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    render(<CopyButton text={() => 'lazy-value'} />);
    await act(async () => void fireEvent.click(screen.getByRole('button')));
    expect(writeText).toHaveBeenCalledWith('lazy-value');
  });
});
