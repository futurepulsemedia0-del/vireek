import { describe, expect, it } from 'vitest';
import { buildManifest, packetFileName, sha256Hex } from './packet';
import type { PacketSection } from './types';

const all = (avail: PacketSection[]) =>
  (['invoice', 'po', 'approval_proof', 'change_order', 'completion_photos', 'signature', 'service_report', 'other_documents'] as const)
    .map((section) => ({ section, available: avail.includes(section) }));

describe('packet manifest ordering', () => {
  it('follows the customer rule, then appends sections the rule forgot', () => {
    const m = buildManifest(['invoice', 'service_report', 'po'], all(['invoice', 'po', 'service_report']));
    expect(m.map((x) => x.section)).toEqual(['invoice', 'service_report', 'po', 'approval_proof', 'change_order', 'completion_photos', 'signature', 'other_documents']);
    expect(m.map((x) => x.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it('marks unavailable sections as not included but keeps their slot', () => {
    const m = buildManifest(['invoice', 'po', 'signature'], all(['invoice', 'signature']));
    expect(m.find((x) => x.section === 'po')?.included).toBe(false);
    expect(m.find((x) => x.section === 'signature')?.included).toBe(true);
  });
  it('re-adds the invoice at the front if a bad rule left it out, drops duplicates and unknown names', () => {
    const m = buildManifest(['po', 'po', 'bogus', 'signature'], all(['invoice']));
    expect(m[0].section).toBe('invoice');
    expect(m.filter((x) => x.section === 'po')).toHaveLength(1);
    expect(m.some((x) => (x.section as string) === 'bogus')).toBe(false);
  });
  it('uses the default order without a rule', () => {
    expect(buildManifest(null, all(['invoice'])).slice(0, 6).map((x) => x.section))
      .toEqual(['invoice', 'po', 'approval_proof', 'completion_photos', 'signature', 'service_report']);
  });
  it('is deterministic', () => {
    expect(buildManifest(['invoice', 'po'], all(['invoice']))).toEqual(buildManifest(['invoice', 'po'], all(['invoice'])));
  });
});

describe('packet file name', () => {
  it('is deterministic and filesystem safe', () => {
    expect(packetFileName('INV-2027/0042', 'abc', 3)).toBe('VRK-INV-2027-0042-packet-v3.pdf');
    expect(packetFileName('../../etc', 'abc', 1)).toBe('VRK-------etc-packet-v1.pdf');
    expect(packetFileName(null, '12345678-aaaa', 2)).toBe('VRK-12345678-packet-v2.pdf');
    expect(packetFileName('', '12345678-aaaa', 2)).toBe('VRK-12345678-packet-v2.pdf');
  });
});

describe('sha256Hex', () => {
  it('matches the known vector for "abc"', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
