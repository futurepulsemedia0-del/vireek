// src/lib/native/instruments.ts
// Registry of Bluetooth LE measurement profiles: which GATT service / characteristic carries
// which quantity, and how to decode it. Pure data + pure decoders (no plugin import), so it is
// trivially testable and the single place to add a new instrument.
//
// Adding a vendor instrument (a gauge, clamp or multimeter with a proprietary protocol) is ONE
// entry — see "Adding a vendor profile" in docs/BLUETOOTH_INSTRUMENTS.md. Do not guess byte
// layouts: take them from the manufacturer's protocol documentation or SDK, then add a test with
// a captured packet.

import {
  decodeEssHumidity,
  decodeEssPressure,
  decodeEssTemperature,
  decodeHealthThermometer,
  type Quantity,
  type Reading,
} from './measurements';

export interface InstrumentProfile {
  /** stable id, e.g. "gatt-health-thermometer" */
  id: string;
  /** shown in diagnostics only */
  label: string;
  quantity: Quantity;
  /** full 128-bit service UUID, lower-case */
  service: string;
  /** full 128-bit characteristic UUID, lower-case */
  characteristic: string;
  decode: (view: DataView) => Reading | null;
}

/** 16-bit Bluetooth SIG UUID → full 128-bit form. */
export function sigUuid(short: number): string {
  return `0000${short.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
}

export const STANDARD_PROFILES: readonly InstrumentProfile[] = [
  { id: 'gatt-health-thermometer', label: 'Health Thermometer', quantity: 'temperature', service: sigUuid(0x1809), characteristic: sigUuid(0x2a1c), decode: decodeHealthThermometer },
  { id: 'gatt-ess-temperature', label: 'Environmental Sensing — temperature', quantity: 'temperature', service: sigUuid(0x181a), characteristic: sigUuid(0x2a6e), decode: decodeEssTemperature },
  { id: 'gatt-ess-humidity', label: 'Environmental Sensing — humidity', quantity: 'humidity', service: sigUuid(0x181a), characteristic: sigUuid(0x2a6f), decode: decodeEssHumidity },
  { id: 'gatt-ess-pressure', label: 'Environmental Sensing — barometric pressure', quantity: 'pressure_abs', service: sigUuid(0x181a), characteristic: sigUuid(0x2a6d), decode: decodeEssPressure },
];

const registry = new Map<string, InstrumentProfile>(STANDARD_PROFILES.map((p) => [p.id, p]));

/** Registers (or replaces) a profile. Call once at startup for each vendor instrument. */
export function registerInstrumentProfile(profile: InstrumentProfile): void {
  registry.set(profile.id, {
    ...profile,
    service: profile.service.toLowerCase(),
    characteristic: profile.characteristic.toLowerCase(),
  });
}

export function profilesFor(quantity: Quantity): InstrumentProfile[] {
  return [...registry.values()].filter((p) => p.quantity === quantity);
}
