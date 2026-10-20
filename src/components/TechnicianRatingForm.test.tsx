import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TechnicianRatingForm } from './TechnicianRatingForm';
import { emptyTechnicianRating, type TechnicianRatingValue } from '@/lib/technicianRatings';

function Harness({ spy = vi.fn() }: { spy?: (v: TechnicianRatingValue) => void }) {
  const [value, setValue] = useState<TechnicianRatingValue>(emptyTechnicianRating);
  return (
    <TechnicianRatingForm
      technicianName="Sam"
      value={value}
      onChange={(next) => {
        spy(next);
        setValue(next);
      }}
    />
  );
}

const star = (n: number) => screen.getByRole('radio', { name: `Rate Sam ${n} out of 5` });

describe('TechnicianRatingForm', () => {
  it('shows no tags or comment until a rating is chosen', () => {
    render(<Harness />);
    expect(screen.queryByRole('button', { name: 'On time' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('offers positive tags for 5 stars and toggles them', () => {
    render(<Harness />);
    fireEvent.click(star(5));
    expect(screen.queryByRole('button', { name: 'Arrived late' })).toBeNull();
    const tag = screen.getByRole('button', { name: 'On time' });
    expect(tag.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(tag);
    expect(tag.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(tag);
    expect(tag.getAttribute('aria-pressed')).toBe('false');
  });

  it('switching to a low rating swaps the tag set and drops tags that are no longer offered', () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    fireEvent.click(star(5));
    fireEvent.click(screen.getByRole('button', { name: 'On time' }));
    fireEvent.click(star(2));
    expect(spy).toHaveBeenLastCalledWith({ rating: 2, tags: [], comment: '' });
    expect(screen.getByRole('button', { name: 'Arrived late' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'On time' })).toBeNull();
  });

  it('clicking the selected star again clears the optional rating', () => {
    render(<Harness />);
    fireEvent.click(star(4));
    expect(star(4).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(star(4));
    expect(star(4).getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('caps selected tags at 6', () => {
    render(<Harness />);
    fireEvent.click(star(3)); // 14 tags offered
    const names = ['On time', 'Professional', 'Clear communication', 'Clean work', 'Knowledgeable', 'Friendly', 'Fair price'];
    names.forEach((n) => fireEvent.click(screen.getByRole('button', { name: n })));
    const pressed = screen.getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(6);
  });

  it('limits the comment to 500 characters', () => {
    render(<Harness />);
    fireEvent.click(star(5));
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(box.maxLength).toBe(500);
    fireEvent.change(box, { target: { value: 'x'.repeat(600) } });
    expect(box.value).toHaveLength(500);
  });
});
