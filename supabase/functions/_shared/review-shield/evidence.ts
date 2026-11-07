// supabase/functions/_shared/review-shield/evidence.ts
//
// Tamper-EVIDENT (not tamper-proof) evidence manifests. Each section is canonically serialised
// and hashed; the snapshot hash covers the section hashes plus generation metadata. The hash only
// proves "unchanged since generated" if it is ALSO recorded somewhere the user cannot edit
// (the write-once review_shield_evidence_packs row + the audit log). It is not a third-party
// trusted timestamp (RFC 3161) — the UI must not claim that.

export const PACK_VERSION = 1;

/** Deterministic JSON: sorted keys, no whitespace, undefined dropped, non-finite numbers rejected. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "undefined":
      return "null";
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface EvidenceManifest {
  version: number;
  generatedAt: string; // ISO, supplied by the caller (server clock)
  accountRef: string; // opaque, NOT the user id
  sections: Record<string, unknown>;
  sectionHashes: Record<string, string>;
  snapshotHash: string;
}

export async function buildManifest(args: {
  generatedAt: string;
  accountRef: string;
  sections: Record<string, unknown>;
}): Promise<EvidenceManifest> {
  const sectionHashes: Record<string, string> = {};
  for (const k of Object.keys(args.sections).sort()) sectionHashes[k] = await sha256Hex(canonicalJson(args.sections[k]));
  const snapshotHash = await sha256Hex(
    canonicalJson({ v: PACK_VERSION, generatedAt: args.generatedAt, accountRef: args.accountRef, sectionHashes }),
  );
  return { version: PACK_VERSION, generatedAt: args.generatedAt, accountRef: args.accountRef, sections: args.sections, sectionHashes, snapshotHash };
}

export type VerifyResult = { ok: true } | { ok: false; reason: "section_changed" | "snapshot_changed"; sections: string[] };

/** Recomputes every hash from the content. `expectedSnapshotHash` should come from the stored row, not from the file. */
export async function verifyManifest(m: EvidenceManifest, expectedSnapshotHash: string): Promise<VerifyResult> {
  const changed: string[] = [];
  for (const k of Object.keys(m.sections)) {
    if ((await sha256Hex(canonicalJson(m.sections[k]))) !== m.sectionHashes[k]) changed.push(k);
  }
  if (changed.length) return { ok: false, reason: "section_changed", sections: changed };
  const recomputed = (await buildManifest({ generatedAt: m.generatedAt, accountRef: m.accountRef, sections: m.sections })).snapshotHash;
  if (recomputed !== expectedSnapshotHash) return { ok: false, reason: "snapshot_changed", sections: [] };
  return { ok: true };
}

/** CSV cell with RFC 4180 quoting AND spreadsheet-formula neutralisation (review text is untrusted). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
