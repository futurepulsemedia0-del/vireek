// supabase/functions/_shared/import-framework/hash.ts
//
// Small, synchronous, dependency-free hashing used for CHANGE DETECTION and DETERMINISTIC IDS only.
// It is NOT cryptographic and must never be used for secrets or integrity guarantees against an
// adversary. Why not crypto.subtle: it is async and its availability differs between Deno, Node and
// jsdom; the engine needs a sync primitive that behaves identically everywhere.
//
// Safety of deterministic ids: every id is derived from (tenant, scope, entity, source key) and every
// sink call is additionally filtered by the tenant, so even a crafted collision can only make ONE row
// fail with a primary-key conflict — it can never read or overwrite another tenant's row.

import { canonical } from "../tenant-export/bundle.ts";

/** cyrb128 (public domain): four 32-bit words from a string. */
function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4; h2 ^= h1; h3 ^= h1; h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

const hex8 = (n: number): string => n.toString(16).padStart(8, "0");

/** 32 lowercase hex chars (128 bit). */
export function fingerprint(input: string): string {
  return cyrb128(input).map(hex8).join("");
}

/** Deterministic JSON: object keys sorted recursively, so equal data always hashes equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

export const fingerprintOf = (value: unknown): string => fingerprint(canonicalJson(value));

/** RFC-4122-shaped UUID (version nibble 8 = custom, variant 10xx) derived from the parts. */
export function deterministicUuid(...parts: string[]): string {
  const h = fingerprint(parts.join("\u0000"));
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
