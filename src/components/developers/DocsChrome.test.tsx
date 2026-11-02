import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const insert = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: { from: () => ({ insert }) } }));

import { DocsFeedback } from './DocsChrome';
import { DocsSearch } from './DocsSearch';

describe('DocsSearch', () => {
  it('opens with Ctrl+K, filters, supports arrows and closes with Escape', () => {
    render(
      <MemoryRouter>
        <DocsSearch />
      </MemoryRouter>,
    );
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'rate_limited' } });
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[0]).toHaveTextContent('rate_limited');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('shows an empty state for no match', () => {
    render(
      <MemoryRouter>
        <DocsSearch />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /search docs/i }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'qqqqzzzz' } });
    expect(screen.getByText(/No results/)).toBeInTheDocument();
  });
});

describe('DocsFeedback', () => {
  beforeEach(() => {
    localStorage.clear();
    insert.mockReset();
  });
  it('sends a yes with no comment, then thanks and remembers', async () => {
    insert.mockResolvedValue({ error: null });
    render(
      <MemoryRouter>
        <DocsFeedback page="/docs" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(await screen.findByText(/Thanks/)).toBeInTheDocument();
    expect(insert).toHaveBeenCalledWith({ page: '/docs', helpful: true, comment: null });
  });
  it('collects a comment on No and surfaces failures', async () => {
    insert.mockResolvedValue({ error: new Error('x') });
    render(
      <MemoryRouter>
        <DocsFeedback page="/docs" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    fireEvent.change(screen.getByLabelText(/missing or wrong/), {
      target: { value: ' needs Go ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(insert).toHaveBeenCalledWith({ page: '/docs', helpful: false, comment: 'needs Go' });
  });
});
