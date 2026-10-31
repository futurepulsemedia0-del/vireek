import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { reactI18nextMock } from '@/test/i18nMock';

vi.mock('react-i18next', () => reactI18nextMock);
const announce = vi.fn();
vi.mock('@/lib/a11y/announcer', () => ({ announce: (...a: unknown[]) => announce(...a) }));

import { Button } from './Button';
import { IconButton } from './IconButton';
import { Pencil } from 'lucide-react';

beforeEach(() => announce.mockClear());

afterEach(cleanup);

describe('Button interaction states', () => {
  it('loading: blocks re-entry, keeps accessible name, sets aria-busy, stays focusable', () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Pay now</Button>);
    const btn = screen.getByRole('button', { name: 'Pay now' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).not.toBeDisabled();
    btn.focus();
    expect(btn).toHaveFocus();
  });

  it('loading: keeps the label in layout (opacity-0, not display:none) so width cannot change', () => {
    render(<Button loading>Pay now</Button>);
    const label = screen.getByText('Pay now');
    expect(label.className).toContain('opacity-0');
    expect(label.className).not.toMatch(/\b(hidden|invisible)\b/);
  });

  it('loading: announces once when loading starts, not on first render and not when it ends', () => {
    const { rerender } = render(<Button loading={false}>Save</Button>);
    expect(announce).not.toHaveBeenCalled();
    rerender(<Button loading>Save</Button>);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Loading…');
    rerender(<Button loading={false}>Save</Button>);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('loading: a custom loadingLabel is announced', () => {
    const { rerender } = render(<Button>Pay</Button>);
    rerender(<Button loading loadingLabel="Processing payment">Pay</Button>);
    expect(announce).toHaveBeenCalledWith('Processing payment');
  });

  it('a loading submit button cannot submit the form twice', () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit" loading>Send</Button>
      </form>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('disabled + reason: aria-disabled (focusable), click blocked, reason is the accessible description', () => {
    const onClick = vi.fn();
    render(<Button disabled disabledReason="Upgrade to Professional to use this" onClick={onClick}>Export</Button>);
    const btn = screen.getByRole('button', { name: 'Export' });
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAccessibleDescription('Upgrade to Professional to use this');
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('disabled without reason stays natively disabled', () => {
    render(<Button disabled>Nope</Button>);
    expect(screen.getByRole('button', { name: 'Nope' })).toBeDisabled();
  });

  it('click on a blocked button does not bubble to a clickable parent', () => {
    const parent = vi.fn();
    render(
      <div onClick={parent}>
        <Button loading>Go</Button>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(parent).not.toHaveBeenCalled();
  });

  it('selected sets aria-pressed and the selected data attribute', () => {
    render(<Button selected>On</Button>);
    const btn = screen.getByRole('button', { name: 'On' });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(btn).toHaveAttribute('data-selected', 'true');
  });

  it('IconButton: label is the accessible name; click works', () => {
    const onClick = vi.fn();
    render(<IconButton label="Edit job" icon={Pencil} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit job' }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
