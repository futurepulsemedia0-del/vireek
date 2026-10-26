// src/lib/native/bluetooth.ts
// Reads ONE measurement from a Bluetooth LE instrument (gauge, thermometer, meter).
// Inside the iOS / Android app it uses the native plugin; in Chrome / Edge (PWA) the same plugin
// falls back to Web Bluetooth, so there is a single code path. Safari and Firefox have no Web
// Bluetooth — isBluetoothSupported() is false there and the form keeps its manual input.
//
// Bluetooth is never initialised until the technician taps "Read from device": on iOS creating
// the central manager is what shows the permission prompt, and that must happen in context.

import { isNative, nativePlatform } from './platform';
import { profilesFor, type InstrumentProfile } from './instruments';
import type { InstrumentReading, Quantity } from './measurements';

export type BluetoothErrorCode =
  | 'unsupported' | 'disabled' | 'denied' | 'timeout' | 'no_profile' | 'disconnected' | 'failed';

export class BluetoothReadError extends Error {
  constructor(public readonly code: BluetoothErrorCode, message: string) {
    super(message);
    this.name = 'BluetoothReadError';
  }
}

const CONNECT_TIMEOUT_MS = 10_000;
export const READING_TIMEOUT_MS = 20_000;

/** Same shape the NFC reader uses for "user cancelled", so callers can treat both alike. */
function abortError(): DOMException {
  return new DOMException('Reading cancelled', 'AbortError');
}

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

export function isBluetoothSupported(): boolean {
  if (isNative()) return true;
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

/** Maps whatever the plugin / browser threw to a code the UI can explain. */
export function classifyBluetoothError(e: unknown): BluetoothReadError | DOMException {
  if (e instanceof BluetoothReadError || isAbortError(e)) return e as BluetoothReadError | DOMException;
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const name = e instanceof Error ? e.name : '';
  // Picker dismissed: Web Bluetooth throws NotFoundError, the native picker says "cancel…".
  if (name === 'NotFoundError' || /cancel|dismiss/i.test(message)) return abortError();
  if (/permission|denied|not authori[sz]ed|unauthori[sz]ed/i.test(message)) {
    return new BluetoothReadError('denied', message);
  }
  if (/not enabled|disabled|powered ?off|turned off|bluetooth.*\boff\b/i.test(message)) {
    return new BluetoothReadError('disabled', message);
  }
  if (name === 'NotSupportedError' || /not (available|supported)/i.test(message)) {
    return new BluetoothReadError('unsupported', message);
  }
  return new BluetoothReadError('failed', message || 'Could not read from the device.');
}

/** Rejects with AbortError as soon as the signal fires; the wrapped promise is left to settle quietly. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

let initialising: Promise<void> | null = null;

async function loadClient() {
  const { BleClient } = await import('@capacitor-community/bluetooth-le');
  // androidNeverForLocation must match the BLUETOOTH_SCAN "neverForLocation" flag in the manifest.
  initialising ??= BleClient.initialize({ androidNeverForLocation: true }).catch((e: unknown) => {
    initialising = null;
    throw e;
  });
  await initialising;
  return BleClient;
}

type Client = Awaited<ReturnType<typeof loadClient>>;

async function ensureEnabled(client: Client): Promise<void> {
  if (await client.isEnabled().catch(() => false)) return;
  // Android can ask the user to switch Bluetooth on from inside the app; iOS cannot.
  if (nativePlatform() === 'android') await client.requestEnable().catch(() => undefined);
  if (!(await client.isEnabled().catch(() => false))) {
    throw new BluetoothReadError('disabled', 'Bluetooth is turned off.');
  }
}

export interface ReadInstrumentOptions {
  quantity: Quantity;
  signal: AbortSignal;
  timeoutMs?: number;
}

/**
 * Opens the system device picker (filtered to instruments that can supply `quantity`), connects,
 * waits for the first valid value, then ALWAYS disconnects. Rejects with AbortError when the
 * technician cancels and with BluetoothReadError for everything else.
 */
export async function readInstrument({
  quantity, signal, timeoutMs = READING_TIMEOUT_MS,
}: ReadInstrumentOptions): Promise<InstrumentReading> {
  const profiles = profilesFor(quantity);
  if (profiles.length === 0) {
    throw new BluetoothReadError('no_profile', 'No supported instrument sends this kind of measurement.');
  }
  if (!isBluetoothSupported()) throw new BluetoothReadError('unsupported', 'Bluetooth is not available here.');
  if (signal.aborted) throw abortError();

  let client: Client | null = null;
  let deviceId: string | null = null;
  let subscribed: InstrumentProfile | null = null;
  let closing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    client = await abortable(loadClient(), signal);
    await abortable(ensureEnabled(client), signal);

    const services = [...new Set(profiles.map((p) => p.service))];
    const device = await abortable(client.requestDevice({ services, optionalServices: services }), signal);
    deviceId = device.deviceId;
    const id = device.deviceId;
    const c = client;

    let rejectGone: (e: Error) => void = () => undefined;
    const gone = new Promise<never>((_, reject) => {
      rejectGone = reject;
    });
    gone.catch(() => undefined); // surfaced through the race below, never as an unhandled rejection

    await abortable(
      c.connect(id, () => {
        if (!closing) rejectGone(new BluetoothReadError('disconnected', 'The device disconnected.'));
      }, { timeout: CONNECT_TIMEOUT_MS }),
      signal,
    );

    const reading = await abortable(
      Promise.race([
        gone,
        (async () => {
          const found = await c.getServices(id);
          const match = profiles
            .map((profile) => {
              const service = found.find((s) => s.uuid.toLowerCase() === profile.service);
              const characteristic = service?.characteristics.find((ch) => ch.uuid.toLowerCase() === profile.characteristic);
              return characteristic ? { profile, characteristic } : null;
            })
            .filter((m): m is NonNullable<typeof m> => m !== null)[0];
          if (!match) throw new BluetoothReadError('no_profile', 'This device does not send that measurement.');

          const { profile, characteristic } = match;
          const props = characteristic.properties;

          if (!props.notify && !props.indicate) {
            const value = profile.decode(await c.read(id, profile.service, profile.characteristic));
            if (!value) throw new BluetoothReadError('failed', 'The device did not return a valid value.');
            return value;
          }

          return new Promise<NonNullable<ReturnType<typeof profile.decode>>>((resolve, reject) => {
            timer = setTimeout(
              () => reject(new BluetoothReadError('timeout', 'No reading arrived from the device.')),
              timeoutMs,
            );
            subscribed = profile;
            c.startNotifications(id, profile.service, profile.characteristic, (view) => {
              const value = profile.decode(view);
              if (value) resolve(value); // sentinel / unknown values are ignored until a real one arrives
            }).catch(reject);
          });
        })(),
      ]),
      signal,
    );

    return { ...reading, deviceId: id, deviceName: device.name?.trim() || 'Bluetooth device', at: new Date().toISOString() };
  } catch (e) {
    throw classifyBluetoothError(e);
  } finally {
    closing = true;
    clearTimeout(timer);
    // Fire-and-forget: a slow disconnect must never keep the UI stuck on "waiting".
    if (client && deviceId) void releaseDevice(client, deviceId, subscribed as InstrumentProfile | null);
  }
}

async function releaseDevice(client: Client, deviceId: string, subscribed: InstrumentProfile | null): Promise<void> {
  if (subscribed) await client.stopNotifications(deviceId, subscribed.service, subscribed.characteristic).catch(() => undefined);
  await client.disconnect(deviceId).catch(() => undefined);
}
