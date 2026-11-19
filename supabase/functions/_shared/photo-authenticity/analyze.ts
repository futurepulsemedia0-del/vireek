// supabase/functions/_shared/photo-authenticity/analyze.ts
//
// Orchestrates one analysis of the sealed original bytes. The caller (edge handler) must already have verified
// that `bytes` hashes to the sealed `original_sha256`; this function trusts that and records the hash it was given.

import { readC2pa, type C2paDeps } from "./c2pa.ts";
import { evaluateConsistency } from "./heuristics.ts";
import { parseImageMetadata } from "./metadata.ts";
import { ANALYZER_VERSION, type AuthenticityReport, type CaptureContext } from "./types.ts";

export async function analyzePhotoAuthenticity(input: {
  bytes: Uint8Array;
  mime: string;
  sha256: string;
  context: CaptureContext;
  c2pa: C2paDeps | null | undefined;
}): Promise<AuthenticityReport> {
  const meta = parseImageMetadata(input.bytes);
  const c2pa = await readC2pa(input.c2pa, input.bytes, input.mime);
  const consistency = evaluateConsistency(meta, c2pa, input.context);
  const captured = meta.dateTimeOriginal ?? meta.dateTimeDigitized;
  return {
    analyzerVersion: ANALYZER_VERSION,
    analyzedSha256: input.sha256,
    analyzedBytes: input.bytes.byteLength,
    metadata: {
      format: meta.format,
      parsedCompletely: meta.parsedCompletely,
      hasExif: meta.hasExif,
      hasXmp: meta.hasXmp,
      hasGps: meta.hasGps,
      camera: meta.make || meta.model ? { make: meta.make, model: meta.model } : null,
      software: meta.software ?? meta.creatorTool,
      // Wall-clock text as stored; the zone is unknown unless the file said so, so no "Z" is added.
      exifCapturedAt: captured ? captured.local + (captured.offsetMinutes !== null ? offsetSuffix(captured.offsetMinutes) : "") : null,
      width: meta.width,
      height: meta.height,
    },
    c2pa,
    consistency,
  };
}

function offsetSuffix(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}
