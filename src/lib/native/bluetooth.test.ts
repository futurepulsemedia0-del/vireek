import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sigUuid } from './instruments';

const ble = vi.hoisted(() => ({
  initialize: vi.fn(),
  isEnabled: vi.fn(),
  requestEnable: vi.fn(),
  requestDevice: vi.fn(),
  connect: vi.fn(),
  getServices: vi.fn(),
  read: vi.fn(),
  startNotifications: vi.fn(),
  stopNotifications: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock('@capacitor-community/bluetooth-le', () => ({ BleClient: ble }));
vi.mock('./platform', () => ({ isNative: () => true, nativePlatform: () => 'android' }));

import { BluetoothReadError, classifyBluetoothError, isAbortError, readInstrument } from './bluetooth';

const view = (...bytes: number[]) => new DataView(new Uint8Array(bytes).buffer);
const THERMO_36_8 = view(0x00, 0x60, 0x0e, 0x00, 0xfe);
const services = (service: number, characteristic: number, properties: Record<string, boolean>) => [
  { uuid: sigUuid(service), characteristics: [{ uuid: sigUuid(characteristic), properties, descriptors: [] }] },
];
const signal = () => new AbortController().signal;

beforeEach(() => {
  vi.clearAllMocks();
  ble.initialize.mockResolvedValue(undefined);
  ble.isEnabled.mockResolvedValue(true);
  ble.requestEnable.mockResolvedValue(undefined);
  ble.requestDevice.mockResolvedValue({ deviceId: 'AA:BB', name: 'Probe' });
  ble.connect.mockResolvedValue(undefined);
  ble.stopNotifications.mockResolvedValue(undefined);
  ble.disconnect.mockResolvedValue(undefined);
  ble.getServices.mockResolvedValue(services(0x1809, 0x2a1c, { indicate: true }));
  ble.startNotifications.mockImplementation(async (_id: string, _s: string, _c: string, cb: (v: DataView) => void) => cb(THERMO_36_8));
});

describe('readInstrument', () => {
  it('returns the first valid indication, then always releases the device', async () => {
    const r = await readInstrument({ quantity: 'temperature', signal: signal() });
    expect(r).toMatchObject({ quantity: 'temperature', value: 36.8, deviceName: 'Probe', deviceId: 'AA:BB' });
    await vi.waitFor(() => expect(ble.disconnect).toHaveBeenCalledWith('AA:BB'));
    expect(ble.stopNotifications).toHaveBeenCalledTimes(1);
  });

  it('ignores "unknown" sentinel packets until a real value arrives', async () => {
    ble.startNotifications.mockImplementation(async (_i: string, _s: string, _c: string, cb: (v: DataView) => void) => {
      cb(view(0x00, 0x00, 0x00, 0x80, 0x00)); // NRes
      cb(THERMO_36_8);
    });
    await expect(readInstrument({ quantity: 'temperature', signal: signal() })).resolves.toMatchObject({ value: 36.8 });
  });

  it('reads once when the characteristic is not notifiable', async () => {
    ble.getServices.mockResolvedValue(services(0x181a, 0x2a6f, { read: true }));
    ble.read.mockResolvedValue(view(0xa0, 0x0f)); // 40.00 %
    await expect(readInstrument({ quantity: 'humidity', signal: signal() })).resolves.toMatchObject({ quantity: 'humidity', value: 40 });
    expect(ble.startNotifications).not.toHaveBeenCalled();
  });

  it('fails with no_profile (and disconnects) when the device lacks the measurement', async () => {
    ble.getServices.mockResolvedValue(services(0x180f, 0x2a19, { read: true }));
    await expect(readInstrument({ quantity: 'temperature', signal: signal() })).rejects.toMatchObject({ code: 'no_profile' });
    await vi.waitFor(() => expect(ble.disconnect).toHaveBeenCalled());
  });

  it('does not open the picker when Bluetooth is off', async () => {
    ble.isEnabled.mockResolvedValue(false);
    await expect(readInstrument({ quantity: 'temperature', signal: signal() })).rejects.toMatchObject({ code: 'disabled' });
    expect(ble.requestDevice).not.toHaveBeenCalled();
  });

  it('fails fast for a quantity no profile can supply (e.g. gauge pressure)', async () => {
    await expect(readInstrument({ quantity: 'pressure_gauge', signal: signal() })).rejects.toMatchObject({ code: 'no_profile' });
    expect(ble.initialize).not.toHaveBeenCalled();
  });

  it('rejects with AbortError when cancelled while the picker is open', async () => {
    ble.requestDevice.mockReturnValue(new Promise(() => undefined));
    const controller = new AbortController();
    const pending = readInstrument({ quantity: 'temperature', signal: controller.signal });
    await vi.waitFor(() => expect(ble.requestDevice).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toSatisfy(isAbortError);
  });

  it('reports a device that drops the connection mid-read', async () => {
    let drop: () => void = () => undefined;
    ble.connect.mockImplementation(async (_id: string, onDisconnect: () => void) => {
      drop = onDisconnect;
    });
    ble.startNotifications.mockResolvedValue(undefined); // subscribed, but no value yet
    const pending = readInstrument({ quantity: 'temperature', signal: signal() });
    await vi.waitFor(() => expect(ble.startNotifications).toHaveBeenCalled());
    drop();
    await expect(pending).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('times out when the device never sends a value', async () => {
    ble.startNotifications.mockResolvedValue(undefined);
    await expect(readInstrument({ quantity: 'temperature', signal: signal(), timeoutMs: 20 })).rejects.toMatchObject({ code: 'timeout' });
    await vi.waitFor(() => expect(ble.disconnect).toHaveBeenCalled());
  });
});

describe('classifyBluetoothError', () => {
  it('maps plugin / browser errors to codes the UI can explain', () => {
    expect(isAbortError(classifyBluetoothError(new Error('requestDevice cancelled')))).toBe(true);
    const notFound = new Error('User cancelled the requestDevice() chooser.');
    notFound.name = 'NotFoundError';
    expect(isAbortError(classifyBluetoothError(notFound))).toBe(true);
    expect(classifyBluetoothError(new Error('Permission denied'))).toMatchObject({ code: 'denied' });
    expect(classifyBluetoothError(new Error('Bluetooth not enabled'))).toMatchObject({ code: 'disabled' });
    expect(classifyBluetoothError(new Error('Web Bluetooth API not available'))).toMatchObject({ code: 'unsupported' });
    expect(classifyBluetoothError(new Error('boom'))).toBeInstanceOf(BluetoothReadError);
  });
});
