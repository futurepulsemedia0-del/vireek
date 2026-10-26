import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ canReadInstrument: vi.fn(), readInstrument: vi.fn() }));
vi.mock('@/lib/native/capabilities', async () => {
  const actual = await vi.importActual<typeof import('@/lib/native/bluetooth')>('@/lib/native/bluetooth');
  return { BluetoothReadError: actual.BluetoothReadError, isAbortError: actual.isAbortError, ...api };
});
vi.mock('@/lib/native/haptics', () => ({ haptic: vi.fn() }));

import { BluetoothReadError } from '@/lib/native/bluetooth';
import { BluetoothReadingButton } from './BluetoothReadingButton';

const AT = '2027-01-05T10:00:00.000Z';
const setup = (props: Partial<React.ComponentProps<typeof BluetoothReadingButton>> = {}) => {
  const onReading = vi.fn();
  render(<BluetoothReadingButton unit="°F" label="Supply temp" source="" onReading={onReading} {...props} />);
  return onReading;
};

beforeEach(() => {
  vi.clearAllMocks();
  api.canReadInstrument.mockReturnValue(true);
});

describe('BluetoothReadingButton', () => {
  it('renders nothing when no instrument can fill this field', () => {
    api.canReadInstrument.mockReturnValue(false);
    setup();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('applies a reading converted to the field unit, with its provenance', async () => {
    api.readInstrument.mockResolvedValue({ quantity: 'temperature', value: 37, deviceId: 'x', deviceName: 'Probe', at: AT });
    const onReading = setup();
    fireEvent.click(screen.getByRole('button', { name: /read supply temp from a bluetooth device/i }));
    await waitFor(() => expect(onReading).toHaveBeenCalledWith('98.6', `bluetooth | Probe | ${AT}`));
  });

  it('shows a cancellable waiting state and returns to idle on cancel', async () => {
    api.readInstrument.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')))),
    );
    const onReading = setup();
    fireEvent.click(screen.getByRole('button', { name: /read supply temp/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/choose your device/i);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('button', { name: /read supply temp/i })).toBeEnabled();
    expect(onReading).not.toHaveBeenCalled();
  });

  it('explains a failure, keeps manual entry possible, and offers a retry', async () => {
    api.readInstrument.mockRejectedValue(new BluetoothReadError('disabled', 'off'));
    const onReading = setup();
    fireEvent.click(screen.getByRole('button', { name: /read supply temp/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/bluetooth is off/i);
    expect(screen.getByRole('button', { name: /supply temp/i })).toHaveTextContent('Try again');
    expect(onReading).not.toHaveBeenCalled();
  });

  it('shows where a stored value came from (also after a draft restore)', () => {
    setup({ source: `bluetooth | Probe | ${AT}` });
    expect(screen.getByRole('status')).toHaveTextContent(/read from probe/i);
    expect(screen.getByRole('button')).toHaveTextContent('Read again');
  });

  it('is disabled while the form is saving', () => {
    setup({ disabled: true });
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
