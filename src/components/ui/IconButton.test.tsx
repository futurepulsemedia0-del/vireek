import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Trash2 } from 'lucide-react';
import { IconButton } from './IconButton';

describe('IconButton', () => {
  it('uses `label` as the accessible name and hides the glyph from AT', () => {
    const { container } = render(<IconButton label="Delete scenario" icon={Trash2} />);
    expect(screen.getByRole('button', { name: 'Delete scenario' })).toBeInTheDocument();
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
  it('is 44px by default (md) and needs no hit-area expansion', () => {
    render(<IconButton label="Close" icon={Trash2} />);
    const btn = screen.getByRole('button', { name: 'Close' });
    expect(btn).toHaveClass('h-11', 'w-11');
    expect(btn).not.toHaveClass('hit-area');
    expect(btn.querySelector('svg')).toHaveClass('icon-md');
  });
  it('expands the hit area (not the visual box) for xs and sm', () => {
    const { rerender } = render(<IconButton label="Edit" icon={Trash2} size="xs" />);
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveClass('h-8', 'w-8', 'hit-area');
    rerender(<IconButton label="Edit" icon={Trash2} size="sm" />);
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveClass('h-10', 'w-10', 'hit-area');
  });
  it('dense = 32px, documented exception: no hit-area, never below 24', () => {
    render(<IconButton label="Row action" icon={Trash2} density="dense" size="lg" />);
    const btn = screen.getByRole('button', { name: 'Row action' });
    expect(btn).toHaveClass('h-8', 'w-8');
    expect(btn).not.toHaveClass('hit-area');
    expect(btn).toHaveAttribute('data-density', 'dense');
  });
  it('keeps Button behaviour (click, disabled)', () => {
    const onClick = vi.fn();
    const { rerender } = render(<IconButton label="Go" icon={Trash2} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledOnce();
    rerender(<IconButton label="Go" icon={Trash2} onClick={onClick} disabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
