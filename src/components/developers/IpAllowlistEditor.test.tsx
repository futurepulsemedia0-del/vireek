import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IpAllowlistEditor } from './IpAllowlistEditor';
import { KeyModeBadge } from './KeyModeBadge';

describe('IpAllowlistEditor', () => {
  it('saves a validated, de-duplicated list', () => {
    const onSave = vi.fn();
    render(
      <IpAllowlistEditor
        initial={['1.2.3.4']}
        saving={false}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '1.2.3.4, 10.0.0.0/8\n1.2.3.4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save allowlist' }));
    expect(onSave).toHaveBeenCalledWith(['1.2.3.4', '10.0.0.0/8']);
  });

  it('blocks saving and explains an invalid entry', () => {
    const onSave = vi.fn();
    render(<IpAllowlistEditor initial={[]} saving={false} onSave={onSave} onCancel={() => {}} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '999.1.1.1' } });
    expect(screen.getByRole('alert')).toHaveTextContent('"999.1.1.1"');
    expect(screen.getByRole('button', { name: 'Save allowlist' })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('allows clearing the list (any address)', () => {
    const onSave = vi.fn();
    render(
      <IpAllowlistEditor
        initial={['1.2.3.4']}
        saving={false}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save allowlist' }));
    expect(onSave).toHaveBeenCalledWith([]);
  });
});

describe('KeyModeBadge', () => {
  it('labels the mode in text, not only color', () => {
    const { rerender } = render(<KeyModeBadge mode="live" />);
    expect(screen.getByText('Live')).toBeInTheDocument();
    rerender(<KeyModeBadge mode="test" />);
    expect(screen.getByText('Test')).toBeInTheDocument();
  });
});
