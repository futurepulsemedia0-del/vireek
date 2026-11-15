import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from './Button';

describe('Button — touch target and link variant', () => {
  it('sm and xs get a 44px minimum on coarse pointers, 40/32 otherwise', () => {
    render(
      <>
        <Button size="sm">Small</Button>
        <Button size="xs">Tiny</Button>
      </>,
    );
    const sm = screen.getByRole('button', { name: 'Small' });
    const xs = screen.getByRole('button', { name: 'Tiny' });
    expect(sm.className).toContain('min-h-[40px]');
    expect(sm.className).toContain('[@media(pointer:coarse)]:min-h-[44px]');
    expect(xs.className).toContain('min-h-[32px]');
    expect(xs.className).toContain('[@media(pointer:coarse)]:min-h-[44px]');
  });

  it('link variant is compact, ignores size, and still fires onClick', () => {
    const onClick = vi.fn();
    render(
      <Button variant="link" size="lg" onClick={onClick}>
        View all
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'View all' });
    expect(btn.className).toContain('min-h-[24px]');
    expect(btn.className).not.toContain('min-h-[52px]');
    expect(btn.className).toContain('text-accent');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
