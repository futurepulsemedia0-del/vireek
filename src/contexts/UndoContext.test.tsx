import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { UndoProvider, useUndo, type UndoRequest } from './UndoContext';

// Exit animations never finish under fake timers; render children directly instead.
vi.mock('framer-motion', () => {
  const strip = (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { initial, animate, exit, transition, ...rest } = props;
    return rest;
  };
  return {
    AnimatePresence: ({ children }: { children: unknown }) => <>{children as never}</>,
    motion: { div: ({ children, ...props }: Record<string, unknown>) => <div {...strip(props)}>{children as never}</div> },
  };
});

function Trigger({ req }: { req: UndoRequest }) {
  const { offerUndo } = useUndo();
  return <button onClick={() => offerUndo(req)}>offer</button>;
}

function setup(req: Partial<UndoRequest> = {}) {
  const undo = vi.fn().mockResolvedValue({ ok: true, message: 'Restored 2 jobs.' });
  const full: UndoRequest = { message: 'Deleted 2 jobs.', undo, ...req };
  render(
    <UndoProvider>
      <input aria-label="field" />
      <Trigger req={full} />
    </UndoProvider>,
  );
  fireEvent.click(screen.getByText('offer'));
  return { undo: full.undo as ReturnType<typeof vi.fn> };
}

describe('UndoProvider', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows the message with an Undo button and auto-dismisses after exactly 10 seconds', () => {
    setup();
    expect(screen.getByText('Deleted 2 jobs.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(9_999));
    expect(screen.getByText('Deleted 2 jobs.')).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(2));
    expect(screen.queryByText('Deleted 2 jobs.')).not.toBeInTheDocument();
  });

  it('runs the inverse once and shows its outcome', async () => {
    const { undo } = setup();
    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    await act(async () => {});
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Restored 2 jobs.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /undo/i })).not.toBeInTheDocument();
  });

  it('surfaces a failing undo instead of throwing', async () => {
    setup({ undo: vi.fn().mockRejectedValue(new Error('network down')) });
    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    await act(async () => {});
    expect(screen.getByText('network down')).toBeInTheDocument();
  });

  it('pauses the countdown while hovered and resumes afterwards', () => {
    setup();
    const toast = screen.getByRole('status');
    fireEvent.mouseEnter(toast);
    act(() => void vi.advanceTimersByTime(30_000));
    expect(screen.getByText('Deleted 2 jobs.')).toBeInTheDocument();
    fireEvent.mouseLeave(toast);
    act(() => void vi.advanceTimersByTime(10_000));
    expect(screen.queryByText('Deleted 2 jobs.')).not.toBeInTheDocument();
  });

  it('Ctrl+Z undoes the latest action, but not while typing in a field', async () => {
    const { undo } = setup();
    fireEvent.keyDown(screen.getByLabelText('field'), { key: 'z', ctrlKey: true });
    expect(undo).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await act(async () => {});
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('does not expire a toast while its undo is still running', async () => {
    let finish: (v: { ok: boolean; message: string }) => void = () => {};
    setup({ undo: vi.fn(() => new Promise((res) => (finish = res))) as UndoRequest['undo'] });
    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    expect(screen.getByText('Undoing…')).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(60_000));
    expect(screen.getByText('Undoing…')).toBeInTheDocument();
    await act(async () => finish({ ok: true, message: 'Done.' }));
    expect(screen.getByText('Done.')).toBeInTheDocument();
  });
});

describe('useUndo', () => {
  it('throws outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Trigger req={{ message: 'x', undo: async () => ({ ok: true, message: '' }) }} />)).toThrow(/UndoProvider/);
    spy.mockRestore();
  });
});
