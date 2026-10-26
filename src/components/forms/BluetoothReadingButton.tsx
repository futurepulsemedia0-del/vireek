// src/components/forms/BluetoothReadingButton.tsx
// "Read from device" for a number field whose unit a Bluetooth instrument can supply.
// States: idle · waiting (cancellable) · done (from the stored provenance, so it survives a draft
// restore) · error. Manual entry always keeps working — a failed read never blocks the form.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bluetooth, BluetoothSearching, Check } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { BluetoothReadError, canReadInstrument, isAbortError, readInstrument } from '@/lib/native/capabilities';
import { haptic } from '@/lib/native/haptics';
import { convertForField, formatSource, parseSource, resolveUnit } from '@/lib/native/measurements';

const ERROR_COPY: Record<string, string> = {
  disabled: 'Bluetooth is off. Turn it on, then try again — or type the value.',
  denied: 'Vireek needs Bluetooth permission. Allow it in Settings, then try again — or type the value.',
  timeout: 'No reading came from the device. Make sure it is on and measuring, then try again.',
  disconnected: 'The device disconnected. Move closer and try again.',
  no_profile: 'That device does not send this measurement. Type the value instead.',
  unsupported: 'Bluetooth is not available here. Type the value instead.',
  failed: 'Could not read from the device. Check it is on and in range, then try again.',
};

type Status = { kind: 'idle' } | { kind: 'waiting' } | { kind: 'error'; message: string };

export interface BluetoothReadingButtonProps {
  /** the field's unit (e.g. "°F"); decides which instrument quantity is requested */
  unit: string | undefined;
  label: string;
  /** current provenance string for this field ('' when the value was typed) */
  source: string;
  disabled?: boolean;
  /** value is already converted to `unit` and rounded */
  onReading: (value: string, source: string) => void;
}

export function BluetoothReadingButton({ unit, label, source, disabled = false, onReading }: BluetoothReadingButtonProps) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  // Leaving the screen mid-read must release the Bluetooth connection.
  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback(async () => {
    const resolved = resolveUnit(unit);
    if (!resolved || abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus({ kind: 'waiting' });
    try {
      const reading = await readInstrument({ quantity: resolved.quantity, signal: controller.signal });
      const value = convertForField(reading, unit);
      if (value === null) throw new BluetoothReadError('failed', 'Unit mismatch');
      if (controller.signal.aborted) return;
      onReading(String(value), formatSource(reading.deviceName, reading.at));
      setStatus({ kind: 'idle' });
      void haptic('success');
    } catch (e) {
      if (isAbortError(e)) {
        setStatus({ kind: 'idle' });
        return;
      }
      const code = e instanceof BluetoothReadError ? e.code : 'failed';
      setStatus({ kind: 'error', message: ERROR_COPY[code] ?? ERROR_COPY.failed });
      void haptic('error');
    } finally {
      abortRef.current = null;
    }
  }, [unit, onReading]);

  if (!canReadInstrument(unit)) return null;

  const done = parseSource(source);

  if (status.kind === 'waiting') {
    return (
      <div role="status" aria-live="polite" className="flex items-center justify-between gap-3 rounded-xl border border-accent/40 bg-accent/10 px-3 py-2.5">
        <span className="flex min-w-0 items-center gap-2 text-sm text-text-primary">
          <BluetoothSearching size={16} className="shrink-0 animate-pulse text-accent" />
          <span>Choose your device, then wait for the reading…</span>
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={() => abortRef.current?.abort()}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {done && status.kind === 'idle' && (
        <p role="status" className="flex items-center gap-2 text-xs text-text-secondary">
          <Check size={14} className="shrink-0 text-success" />
          <span className="truncate">
            Read from {done.deviceName} at {new Date(done.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </span>
        </p>
      )}
      {status.kind === 'error' && (
        <p role="alert" className="flex items-start gap-2 text-xs text-danger">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{status.message}</span>
        </p>
      )}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={disabled}
        aria-label={`${done ? 'Read again' : 'Read'} ${label} from a Bluetooth device`}
        onClick={() => void start()}
      >
        <Bluetooth size={16} /> {status.kind === 'error' ? 'Try again' : done ? 'Read again' : 'Read from device'}
      </Button>
    </div>
  );
}
