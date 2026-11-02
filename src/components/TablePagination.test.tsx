import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, o?: Record<string, unknown> & { defaultValue?: string }) =>
      (o?.defaultValue ?? _k).replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(o?.[name] ?? '')),
  }),
}));

import { TablePagination } from './TablePagination';

afterEach(cleanup);

describe('TablePagination', () => {
  it('renders nothing when everything fits on one page', () => {
    const { container } = render(<TablePagination page={1} total={10} pageSize={25} onPage={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('shows the range and disables Previous on page 1', () => {
    render(<TablePagination page={1} total={53} pageSize={25} onPage={() => undefined} />);
    expect(screen.getByText('1–25 of 53')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
  });
  it('goes to the next page and disables Next on the last page', () => {
    const onPage = vi.fn();
    const { rerender } = render(<TablePagination page={2} total={53} pageSize={25} onPage={onPage} />);
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(onPage).toHaveBeenCalledWith(3);
    rerender(<TablePagination page={3} total={53} pageSize={25} onPage={onPage} />);
    expect(screen.getByText('51–53 of 53')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
  });
});
