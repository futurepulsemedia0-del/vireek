// src/lib/native/measurements.ts
// Pure maths for instrument readings: unit resolution / conversion, the standard Bluetooth GATT
// value decoders, and the provenance string stored next to a number answer. No plugin, no DOM,
// no network — the same code runs in the app, the PWA and the unit tests.
//
// Readings travel in ONE base unit per quantity (°C, %, Pa, V, A) and are converted to the
// unit written on the form field (field.unit) only at the moment they are applied.

export type Quantity = 'temperature' | 'humidity' | 'pressure_abs' | 'pressure_gauge' | 'voltage' | 'current';

/** A decoded value in the base unit of its quantity. */
export interface Reading {
  quantity: Quantity;
  value: number;
}

/** A reading plus where it came from (kept as provenance on the form answer). */
export interface InstrumentReading extends Reading {
  deviceId: string;
  deviceName: string;
  /** ISO-8601 time the app received the value */
  at: string;
}

interface UnitDef {
  quantity: Quantity;
  fromBase: (base: number) => number;
}

const linear = (quantity: Quantity, perBase: number): UnitDef => ({ quantity, fromBase: (b) => b / perBase });

const PSI_PA = 6894.757293168;
const INHG_PA = 3386.389;
const INWC_PA = 249.0889;

// Keys are normalised by normalizeUnit(). Pressure is split on purpose:
//  - gauge  (psi, psig, kPa, bar, in. w.c.) is what refrigerant / gas / duct work means by a bare
//    unit in the field-service trade, and standard Bluetooth profiles never carry it;
//  - absolute (psia, hPa, mbar, inHg) is barometric pressure, which the standard Environmental
//    Sensing profile does carry.
// Never converting between the two keeps a barometer from silently filling a gauge field.
const UNITS: Record<string, UnitDef> = {
  c: { quantity: 'temperature', fromBase: (b) => b },
  celsius: { quantity: 'temperature', fromBase: (b) => b },
  f: { quantity: 'temperature', fromBase: (b) => (b * 9) / 5 + 32 },
  fahrenheit: { quantity: 'temperature', fromBase: (b) => (b * 9) / 5 + 32 },

  '%': linear('humidity', 1),
  '%rh': linear('humidity', 1),
  rh: linear('humidity', 1),

  psi: linear('pressure_gauge', PSI_PA),
  psig: linear('pressure_gauge', PSI_PA),
  kpa: linear('pressure_gauge', 1000),
  kpag: linear('pressure_gauge', 1000),
  bar: linear('pressure_gauge', 100_000),
  barg: linear('pressure_gauge', 100_000),
  inwc: linear('pressure_gauge', INWC_PA),

  psia: linear('pressure_abs', PSI_PA),
  pa: linear('pressure_abs', 1),
  hpa: linear('pressure_abs', 100),
  mbar: linear('pressure_abs', 100),
  inhg: linear('pressure_abs', INHG_PA),

  v: linear('voltage', 1),
  mv: linear('voltage', 0.001),
  a: linear('current', 1),
  ma: linear('current', 0.001),
  ua: linear('current', 0.000_001),
};

/** "°F", " psi ", "in. w.c.", "µA", "%RH" → "f", "psi", "inwc", "ua", "%rh". */
export function normalizeUnit(unit: string | undefined | null): string {
  return (unit ?? '')
    .trim()
    .toLowerCase()
    .replace(/µ|μ/g, 'u')
    .replace(/[°\s._/-]/g, '')
    .replace(/^deg/, '');
}

/** What a form field's unit means, or null when no instrument could fill it. */
export function resolveUnit(unit: string | undefined | null): UnitDef | null {
  return UNITS[normalizeUnit(unit)] ?? null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The reading expressed in the field's unit (2 decimals), or null when the units do not match. */
export function convertForField(reading: Reading, fieldUnit: string | undefined | null): number | null {
  const def = resolveUnit(fieldUnit);
  if (!def || def.quantity !== reading.quantity || !Number.isFinite(reading.value)) return null;
  const out = round2(def.fromBase(reading.value));
  return Number.isFinite(out) ? out : null;
}

// ------------------------------------------------------------
// Standard GATT decoders. Each returns null for "no / invalid value" so a sensor that is still
// warming up (sentinel values) never writes a bogus number into a job form.
// ------------------------------------------------------------

/** IEEE-11073 32-bit FLOAT (Health Thermometer): 24-bit signed mantissa, 8-bit signed exponent. */
export function decodeIeee11073Float(view: DataView, offset: number): number | null {
  if (offset < 0 || view.byteLength < offset + 4) return null;
  const raw = view.getUint32(offset, true);
  let mantissa = raw & 0x00ff_ffff;
  const exponent = (raw >>> 24) << 24 >> 24; // sign-extend 8 bits
  // 0x7FFFFF NaN · 0x800000 NRes · 0x7FFFFE +INF · 0x800002 −INF · 0x800001 reserved
  if (mantissa >= 0x7f_fffe && mantissa <= 0x80_0002) return null;
  if (mantissa >= 0x80_0000) mantissa -= 0x100_0000;
  const value = exponent < 0 ? mantissa / 10 ** -exponent : mantissa * 10 ** exponent;
  return Number.isFinite(value) ? value : null;
}

/** Temperature Measurement 0x2A1C / Intermediate Temperature 0x2A1E: flags byte (bit0 = °F) + FLOAT. */
export function decodeHealthThermometer(view: DataView): Reading | null {
  if (view.byteLength < 5) return null;
  const value = decodeIeee11073Float(view, 1);
  if (value === null) return null;
  const celsius = (view.getUint8(0) & 0x01) !== 0 ? ((value - 32) * 5) / 9 : value;
  return { quantity: 'temperature', value: celsius };
}

/** Environmental Sensing Temperature 0x2A6E: sint16, 0.01 °C, 0x8000 = unknown. */
export function decodeEssTemperature(view: DataView): Reading | null {
  if (view.byteLength < 2) return null;
  const raw = view.getInt16(0, true);
  return raw === -0x8000 ? null : { quantity: 'temperature', value: raw / 100 };
}

/** Environmental Sensing Humidity 0x2A6F: uint16, 0.01 %, 0xFFFF = unknown. */
export function decodeEssHumidity(view: DataView): Reading | null {
  if (view.byteLength < 2) return null;
  const raw = view.getUint16(0, true);
  return raw === 0xffff || raw > 10_000 ? null : { quantity: 'humidity', value: raw / 100 };
}

/** Environmental Sensing Pressure 0x2A6D: uint32, 0.1 Pa (absolute / barometric). */
export function decodeEssPressure(view: DataView): Reading | null {
  if (view.byteLength < 4) return null;
  const raw = view.getUint32(0, true);
  return raw === 0xffff_ffff ? null : { quantity: 'pressure_abs', value: raw / 10 };
}

// ------------------------------------------------------------
// Provenance. Stored at answers[`${fieldId}__source`] so an inspector can tell a typed number
// from a number that came straight off an instrument.
// ------------------------------------------------------------

const SOURCE_PREFIX = 'bluetooth';
const SOURCE_SEPARATOR = ' | ';

export function formatSource(deviceName: string, at: string): string {
  // eslint-disable-next-line no-control-regex
  const name = deviceName.replace(/[\u0000-\u001f|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Bluetooth device';
  return [SOURCE_PREFIX, name, at].join(SOURCE_SEPARATOR);
}

export function parseSource(source: string | undefined): { deviceName: string; at: string } | null {
  if (!source) return null;
  const [prefix, deviceName, at] = source.split(SOURCE_SEPARATOR);
  return prefix === SOURCE_PREFIX && deviceName && at ? { deviceName, at } : null;
}
