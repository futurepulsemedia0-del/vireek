import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { useFocusTrap } from './focusTrap';

function Demo({ removeTrigger = false }: { removeTrigger?: boolean }) {
  const [open, setOpen] = useState(false);
  const [showTrigger, setShowTrigger] = useState(true);
  const ref = useFocusTrap(open);
  return (
    <div>
      <main data-focus-fallback tabIndex={-1}>main</main>
      {showTrigger && <button onClick={() => setOpen(true)}>Open</button>}
      {open && (
        <div ref={ref} role="dialog" aria-label="d">
          <button>First</button>
          <button
            onClick={() => {
              if (removeTrigger) setShowTrigger(false);
              setOpen(false);
            }}
          >
            Last
          </button>
        </div>
      )}
    </div>
  );
}

afterEach(cleanup);

describe('useFocusTrap', () => {
  it('moves focus in, cycles Tab inside, and restores focus to the trigger', () => {
    render(<Demo />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    screen.getByRole('button', { name: 'Last' }).focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Last' }));
    expect(trigger).toHaveFocus();
  });

  it('falls back to [data-focus-fallback] when the trigger was unmounted', () => {
    render(<Demo removeTrigger />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Last' }));
    expect(screen.getByText('main')).toHaveFocus();
  });
});
