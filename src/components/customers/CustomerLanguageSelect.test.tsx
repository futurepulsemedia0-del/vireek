import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  CustomerLanguageControl,
  CustomerLanguageSelect,
} from '@/components/customers/CustomerLanguageSelect';

const toast = vi.fn();
const updateCustomerLanguage = vi.fn();

vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/customerLanguage', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/customerLanguage')>('@/lib/customerLanguage');
  return { ...actual, updateCustomerLanguage: (...a: unknown[]) => updateCustomerLanguage(...a) };
});

afterEach(cleanup);

beforeEach(() => {
  toast.mockReset();
  updateCustomerLanguage.mockReset();
});

describe('CustomerLanguageSelect', () => {
  it('lists "not set" plus all 9 languages and reports the selection as a code', () => {
    const onChange = vi.fn();
    render(<CustomerLanguageSelect value={null} onChange={onChange} />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.options).toHaveLength(10);
    expect(select.value).toBe('');
    fireEvent.change(select, { target: { value: 'fa' } });
    expect(onChange).toHaveBeenCalledWith('fa');
    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('shows the current value', () => {
    render(<CustomerLanguageSelect value="es" onChange={() => {}} />);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('es');
  });
});

describe('CustomerLanguageControl', () => {
  it('saves a staff change and notifies the parent', async () => {
    updateCustomerLanguage.mockResolvedValue(true);
    const onChanged = vi.fn();
    render(
      <CustomerLanguageControl
        customerId="c1"
        language="es"
        source="auto_detected"
        onChanged={onChanged}
      />,
    );
    expect(screen.getByText('Detected automatically')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'de' } });
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('de'));
    expect(updateCustomerLanguage).toHaveBeenCalledWith('c1', 'de');
    expect(toast).toHaveBeenCalledWith('Language updated.', 'success');
  });

  it('does not call the API when nothing changed', () => {
    render(
      <CustomerLanguageControl customerId="c1" language="es" source="staff" onChanged={vi.fn()} />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'es' } });
    expect(updateCustomerLanguage).not.toHaveBeenCalled();
  });

  it('reports failure and does not update the parent', async () => {
    updateCustomerLanguage.mockResolvedValue(false);
    const onChanged = vi.fn();
    render(
      <CustomerLanguageControl
        customerId="c1"
        language={null}
        source={null}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByText(/adapt on the first call/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ja' } });
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Could not update the language.', 'error'),
    );
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('can clear the language', async () => {
    updateCustomerLanguage.mockResolvedValue(true);
    const onChanged = vi.fn();
    render(
      <CustomerLanguageControl
        customerId="c1"
        language="fr"
        source="staff"
        onChanged={onChanged}
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(null));
    expect(updateCustomerLanguage).toHaveBeenCalledWith('c1', null);
  });
});
