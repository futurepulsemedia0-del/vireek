import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeTabs } from './CodeTabs';

const tabs = [
  { id: 'curl', label: 'cURL', source: 'curl example' },
  { id: 'javascript', label: 'JavaScript', source: 'js example' },
  { id: 'go', label: 'Go', source: 'go example' },
];

describe('CodeTabs', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('shows the first tab, switches on click and remembers the choice', () => {
    const { unmount } = render(<CodeTabs label="Language" tabs={tabs} />);
    expect(screen.getByRole('tab', { name: 'cURL' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('curl example')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Go' }));
    expect(screen.getByText('go example')).toBeInTheDocument();
    expect(localStorage.getItem('vireek_docs_lang')).toBe('go');

    unmount();
    render(<CodeTabs label="Language" tabs={tabs} />);
    expect(screen.getByRole('tab', { name: 'Go' })).toHaveAttribute('aria-selected', 'true');
  });

  it('supports arrow, Home and End keys with roving tabindex', () => {
    render(<CodeTabs label="Language" tabs={tabs} />);
    const list = screen.getByRole('tablist');
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'JavaScript' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'JavaScript' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'cURL' })).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(list, { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Go' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'cURL' })).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps every CodeTabs on the page in sync', () => {
    render(
      <>
        <CodeTabs label="A" tabs={tabs} />
        <CodeTabs label="B" tabs={tabs} />
      </>,
    );
    fireEvent.click(screen.getAllByRole('tab', { name: 'JavaScript' })[0]);
    for (const t of screen.getAllByRole('tab', { name: 'JavaScript' }))
      expect(t).toHaveAttribute('aria-selected', 'true');
  });

  it('copies the active sample and still works when storage is blocked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<CodeTabs label="Language" tabs={tabs} />);
    fireEvent.click(screen.getByRole('tab', { name: 'JavaScript' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy JavaScript code' }));
    expect(writeText).toHaveBeenCalledWith('js example');
    expect(await screen.findByText('Copied')).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
