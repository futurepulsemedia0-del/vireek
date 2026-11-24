import type { PacketSection } from './types';
import { DEFAULT_PACKET_ORDER, PACKET_SECTIONS } from './types';

/** Invoice packet helpers (PURE). The server assigns version + final name; this mirrors the SQL for previews/tests. */
export interface PacketSectionInput {
  section: PacketSection;
  /** false = nothing to include (e.g. no signature captured) */
  available: boolean;
}

export interface ManifestEntry {
  position: number;
  section: PacketSection;
  included: boolean;
}

/**
 * Orders the sections per the customer's rule. Unknown or duplicate sections are dropped, 'invoice' is always
 * first-class (re-added at the front if a bad rule omitted it) and any known section the rule did not mention is
 * appended in default order so evidence is never silently lost.
 */
export function buildManifest(order: readonly string[] | null | undefined, sections: readonly PacketSectionInput[]): ManifestEntry[] {
  const known = new Set<string>(PACKET_SECTIONS);
  const seen = new Set<PacketSection>();
  const ordered: PacketSection[] = [];
  const push = (s: string) => {
    if (known.has(s) && !seen.has(s as PacketSection)) { seen.add(s as PacketSection); ordered.push(s as PacketSection); }
  };
  if (!order || order.length === 0 || !order.includes('invoice')) push('invoice');
  for (const s of order && order.length > 0 ? order : DEFAULT_PACKET_ORDER) push(s);
  for (const s of PACKET_SECTIONS) push(s);
  const avail = new Map(sections.map((s) => [s.section, s.available]));
  return ordered.map((section, i) => ({ position: i + 1, section, included: avail.get(section) === true }));
}

/** Same sanitising as the SQL: [^A-Za-z0-9_-] -> '-'. */
export function packetFileName(invoiceNumber: string | null, invoiceId: string, version: number): string {
  const base = invoiceNumber && invoiceNumber.length > 0 ? invoiceNumber : invoiceId.slice(0, 8);
  return `VRK-${base.replace(/[^A-Za-z0-9_-]/g, '-')}-packet-v${version}.pdf`;
}

export async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
