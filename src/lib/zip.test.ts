import { describe, expect, it } from 'vitest';
import { buildZip, crc32 } from './zip';

describe('crc32', () => {
  it('matches known vectors', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe('buildZip', () => {
  const entries = [
    { name: '01-before-kitchen.jpg', data: new Uint8Array([1, 2, 3, 4, 5]) },
    { name: '02-after-گالری.png', data: new TextEncoder().encode('hello zip') },
    { name: 'empty.txt', data: new Uint8Array() },
  ];

  it('writes a structurally valid archive', () => {
    const zip = buildZip(entries);
    const v = new DataView(zip.buffer);
    expect(v.getUint32(0, true)).toBe(0x04034b50); // first local header
    const eocd = zip.length - 22;
    expect(v.getUint32(eocd, true)).toBe(0x06054b50);
    expect(v.getUint16(eocd + 10, true)).toBe(3); // entry count
    // central directory starts where EOCD says and begins with its signature
    const cdStart = v.getUint32(eocd + 16, true);
    expect(v.getUint32(cdStart, true)).toBe(0x02014b50);
    expect(cdStart + v.getUint32(eocd + 12, true)).toBe(eocd);
  });

  it('stores bytes untouched with the right CRC', () => {
    const zip = buildZip([entries[0]]);
    const v = new DataView(zip.buffer);
    const nameLen = v.getUint16(26, true);
    expect(v.getUint32(14, true)).toBe(crc32(entries[0].data));
    expect([...zip.slice(30 + nameLen, 30 + nameLen + 5)]).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects absurd entry counts', () => {
    const many = Array.from({ length: 0x10000 }, (_, i) => ({
      name: `${i}`,
      data: new Uint8Array(),
    }));
    expect(() => buildZip(many)).toThrow(/too many/i);
  });
});
