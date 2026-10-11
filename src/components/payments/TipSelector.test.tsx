import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TipSelector } from './TipSelector';

const base = { baseCents: 10000, presets: [15, 18, 20, 25], technicianName: 'Sam' };

describe('TipSelector', () => {
  it('shows the technician name and the dollar value of each preset', () => {
    render(<TipSelector {...base} value={{ kind: 'none' }} onChange={() => {}} />);
    expect(screen.getByText('Add a tip for Sam')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /20%/ })).toHaveTextContent('$20.00');
  });

  it('emits a percent selection', () => {
    const onChange = vi.fn();
    render(<TipSelector {...base} value={{ kind: 'none' }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: /18%/ }));
    expect(onChange).toHaveBeenCalledWith({ kind: 'percent', percent: 18 });
  });

  it('emits custom cents for a valid dollar amount', () => {
    const onChange = vi.fn();
    render(<TipSelector {...base} value={{ kind: 'none' }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Custom tip amount in dollars'), { target: { value: '7.50' } });
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'custom', cents: 750 });
  });

  it('flags an invalid custom amount', () => {
    render(<TipSelector {...base} value={{ kind: 'custom', cents: Number.NaN }} onChange={() => {}} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('resets to no tip when the custom field is cleared', () => {
    const onChange = vi.fn();
    render(<TipSelector {...base} value={{ kind: 'none' }} onChange={onChange} />);
    const input = screen.getByLabelText('Custom tip amount in dollars');
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'none' });
  });
});
