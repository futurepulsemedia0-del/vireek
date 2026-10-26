import { describe, expect, it } from 'vitest';
import {
  convertForField, decodeEssHumidity, decodeEssPressure, decodeEssTemperature, decodeHealthThermometer,
  decodeIeee11073Float, formatSource, normalizeUnit, parseSource, resolveUnit,
} from './measurements';

const view = (...bytes: number[]) => new DataView(new Uint8Array(bytes).buffer);

describe('unit resolution', () => {
  it('normalises the spellings technicians actually type', () => {
    expect(normalizeUnit(' °F ')).toBe('f');
    expect(normalizeUnit('in. w.c.')).toBe('inwc');
    expect(normalizeUnit('µA')).toBe('ua');
    expect(normalizeUnit('%RH')).toBe('%rh');
  });

  it('keeps gauge and absolute pressure apart so a barometer never fills a gauge field', () => {
    expect(resolveUnit('psi')?.quantity).toBe('pressure_gauge');
    expect(resolveUnit('psig')?.quantity).toBe('pressure_gauge');
    expect(resolveUnit('inHg')?.quantity).toBe('pressure_abs');
    expect(resolveUnit('ppm')).toBeNull();
    expect(resolveUnit(undefined)).toBeNull();
  });
});

describe('convertForField', () => {
  it('converts the base unit to the field unit', () => {
    expect(convertForField({ quantity: 'temperature', value: 37 }, '°F')).toBe(98.6);
    expect(convertForField({ quantity: 'temperature', value: 37 }, 'C')).toBe(37);
    expect(convertForField({ quantity: 'pressure_abs', value: 101_325 }, 'hPa')).toBe(1013.25);
  });

  it('refuses a reading of a different quantity', () => {
    expect(convertForField({ quantity: 'humidity', value: 40 }, '°F')).toBeNull();
    expect(convertForField({ quantity: 'temperature', value: Number.NaN }, '°F')).toBeNull();
  });
});

describe('standard GATT decoders', () => {
  it('decodes an IEEE-11073 FLOAT (mantissa 3680, exponent -2 = 36.8)', () => {
    expect(decodeIeee11073Float(view(0x60, 0x0e, 0x00, 0xfe), 0)).toBe(36.8);
    expect(decodeIeee11073Float(view(0x60, 0x0e), 0)).toBeNull();
  });

  it('treats IEEE-11073 special values as "no reading"', () => {
    expect(decodeIeee11073Float(view(0xff, 0xff, 0x7f, 0x00), 0)).toBeNull(); // NaN
    expect(decodeIeee11073Float(view(0x00, 0x00, 0x80, 0x00), 0)).toBeNull(); // NRes
  });

  it('decodes a Health Thermometer packet in °C and in °F', () => {
    expect(decodeHealthThermometer(view(0x00, 0x60, 0x0e, 0x00, 0xfe))).toEqual({ quantity: 'temperature', value: 36.8 });
    const f = decodeHealthThermometer(view(0x01, 0xda, 0x03, 0x00, 0xff)); // 98.6 °F
    expect(f?.value).toBeCloseTo(37, 5);
  });

  it('decodes Environmental Sensing temperature, humidity and pressure, ignoring "unknown"', () => {
    expect(decodeEssTemperature(view(0x34, 0x08))).toEqual({ quantity: 'temperature', value: 21 }); // 2100 × 0.01
    expect(decodeEssTemperature(view(0x00, 0x80))).toBeNull();
    expect(decodeEssHumidity(view(0xa0, 0x0f))).toEqual({ quantity: 'humidity', value: 40 });
    expect(decodeEssHumidity(view(0xff, 0xff))).toBeNull();
    expect(decodeEssPressure(view(0x02, 0x76, 0x0f, 0x00))).toEqual({ quantity: 'pressure_abs', value: 101_325 });
    expect(decodeEssPressure(view(0x01))).toBeNull();
  });
});

describe('provenance string', () => {
  it('round-trips and strips the separator from device names', () => {
    const s = formatSource('Probe | A', '2027-01-05T10:00:00.000Z');
    expect(parseSource(s)).toEqual({ deviceName: 'Probe A', at: '2027-01-05T10:00:00.000Z' });
    expect(parseSource('')).toBeNull();
    expect(parseSource('typed | x | y')).toBeNull();
  });
});
